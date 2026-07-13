import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

export function getWalletSystemLamportsRequired(
  instructions: readonly TransactionInstruction[],
  wallet: PublicKey,
): bigint {
  return instructions.reduce((total, instruction) => {
    if (!instruction.programId.equals(SystemProgram.programId)) return total;

    const type = SystemInstruction.decodeInstructionType(instruction);
    switch (type) {
      case "Create": {
        const decoded = SystemInstruction.decodeCreateAccount(instruction);
        return decoded.fromPubkey.equals(wallet) ? total + BigInt(decoded.lamports) : total;
      }
      case "Transfer": {
        const decoded = SystemInstruction.decodeTransfer(instruction);
        return decoded.fromPubkey.equals(wallet) ? total + BigInt(decoded.lamports) : total;
      }
      default:
        return total;
    }
  }, 0n);
}
