/**
 * Pool-level realized-PnL kill switch.
 *
 * The detector is deliberately based only on known realized values and uses
 * the newest closes first. It blocks re-entry through the existing persisted
 * pool-cooldown path; it never decides whether an existing position should
 * EXIT.
 */

export interface PoolPnlObservation {
  readonly positionId: string;
  readonly poolAddress: string;
  readonly realizedPnlUsd: number | null | undefined;
}

export interface PoolPnlKillSwitchConfig {
  readonly minClosedPositions: number;
  readonly thresholdUsd: number;
}

export interface PoolPnlKillSwitchTrip {
  readonly poolAddress: string;
  readonly positionIds: ReadonlyArray<string>;
  readonly realizedPnlUsd: number;
}

/**
 * Find pools whose trailing realized PnL is strictly below the configured
 * threshold. Unknown/non-finite realized values do not count toward N and do
 * not contribute to the sum, so the switch fails open on incomplete ledger
 * data rather than treating an unresolved close as a loss.
 */
export function findPoolPnlKillSwitchTrips(
  observations: ReadonlyArray<PoolPnlObservation>,
  config: PoolPnlKillSwitchConfig,
): ReadonlyArray<PoolPnlKillSwitchTrip> {
  const minClosedPositions = Math.max(1, Math.floor(config.minClosedPositions));
  const byPool = new Map<string, PoolPnlObservation[]>();

  for (const observation of observations) {
    const list = byPool.get(observation.poolAddress);
    if (list) {
      list.push(observation);
    } else {
      byPool.set(observation.poolAddress, [observation]);
    }
  }

  const trips: PoolPnlKillSwitchTrip[] = [];
  for (const [poolAddress, poolObservations] of byPool) {
    const known = poolObservations.filter(
      (observation): observation is PoolPnlObservation & { readonly realizedPnlUsd: number } =>
        observation.realizedPnlUsd !== null &&
        observation.realizedPnlUsd !== undefined &&
        Number.isFinite(observation.realizedPnlUsd),
    );
    if (known.length < minClosedPositions) continue;

    const trailing = known.slice(0, minClosedPositions);
    const realizedPnlUsd = trailing.reduce(
      (sum, observation) => sum + observation.realizedPnlUsd,
      0,
    );
    if (realizedPnlUsd < config.thresholdUsd) {
      trips.push({
        poolAddress,
        positionIds: trailing.map((observation) => observation.positionId),
        realizedPnlUsd,
      });
    }
  }

  return trips;
}
