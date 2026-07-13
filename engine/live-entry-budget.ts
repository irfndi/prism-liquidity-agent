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

    try {
      const type = SystemInstruction.decodeInstructionType(instruction);
      switch (type) {
        case "Create": {
          const decoded = SystemInstruction.decodeCreateAccount(instruction);
          return decoded.fromPubkey.equals(wallet) ? total + BigInt(decoded.lamports) : total;
        }
        case "CreateWithSeed": {
          const decoded = SystemInstruction.decodeCreateWithSeed(instruction);
          return decoded.fromPubkey.equals(wallet) ? total + BigInt(decoded.lamports) : total;
        }
        case "Transfer": {
          const decoded = SystemInstruction.decodeTransfer(instruction);
          return decoded.fromPubkey.equals(wallet) ? total + BigInt(decoded.lamports) : total;
        }
        case "TransferWithSeed": {
          const decoded = SystemInstruction.decodeTransferWithSeed(instruction);
          return decoded.fromPubkey.equals(wallet) ? total + BigInt(decoded.lamports) : total;
        }
        default:
          return total;
      }
    } catch (error) {
      throw new Error("Unable to decode System Program instruction for SOL budgeting", {
        cause: error,
      });
    }
  }, 0n);
}
