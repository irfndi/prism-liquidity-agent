import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

function walletOutflow(
  fromPubkey: PublicKey,
  lamports: number | bigint,
  wallet: PublicKey,
): bigint {
  if (!fromPubkey.equals(wallet)) return 0n;
  return BigInt(lamports);
}

function decodedSystemOutflow(
  type: string,
  instruction: TransactionInstruction,
  wallet: PublicKey,
): bigint {
  switch (type) {
    case "Create": {
      const decoded = SystemInstruction.decodeCreateAccount(instruction);
      return walletOutflow(decoded.fromPubkey, decoded.lamports, wallet);
    }
    case "CreateWithSeed": {
      const decoded = SystemInstruction.decodeCreateWithSeed(instruction);
      return walletOutflow(decoded.fromPubkey, decoded.lamports, wallet);
    }
    case "Transfer": {
      const decoded = SystemInstruction.decodeTransfer(instruction);
      return walletOutflow(decoded.fromPubkey, decoded.lamports, wallet);
    }
    case "TransferWithSeed": {
      const decoded = SystemInstruction.decodeTransferWithSeed(instruction);
      return walletOutflow(decoded.fromPubkey, decoded.lamports, wallet);
    }
    default:
      return 0n;
  }
}

function systemInstructionWalletLamports(
  instruction: TransactionInstruction,
  wallet: PublicKey,
): bigint {
  if (!instruction.programId.equals(SystemProgram.programId)) return 0n;
  try {
    return decodedSystemOutflow(
      SystemInstruction.decodeInstructionType(instruction),
      instruction,
      wallet,
    );
  } catch (error) {
    throw new Error("Unable to decode System Program instruction for SOL budgeting", {
      cause: error,
    });
  }
}

export function getWalletSystemLamportsRequired(
  instructions: readonly TransactionInstruction[],
  wallet: PublicKey,
): bigint {
  return instructions.reduce(
    (total, instruction) => total + systemInstructionWalletLamports(instruction, wallet),
    0n,
  );
}
