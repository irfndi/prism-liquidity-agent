import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getWalletSystemLamportsRequired } from "../engine/live-entry-budget.js";

describe("getWalletSystemLamportsRequired", () => {
  it("counts wallet-funded account creation and transfers", () => {
    // Given a transaction that creates an account and wraps SOL from the wallet
    const wallet = Keypair.generate().publicKey;
    const account = Keypair.generate().publicKey;
    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet,
        newAccountPubkey: account,
        lamports: 4_000_000,
        space: 0,
        programId: SystemProgram.programId,
      }),
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: account,
        lamports: 7_000_000,
      }),
    );

    // When the transaction budget is calculated
    const required = getWalletSystemLamportsRequired(transaction.instructions, wallet);

    // Then every direct wallet debit is included
    expect(required).toBe(11_000_000n);
  });

  it("ignores system debits funded by another account", () => {
    // Given a transaction with a system transfer from another payer
    const wallet = Keypair.generate().publicKey;
    const otherPayer = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: otherPayer,
        toPubkey: recipient,
        lamports: 9_000_000,
      }),
    );

    // When the wallet budget is calculated
    const required = getWalletSystemLamportsRequired(transaction.instructions, wallet);

    // Then unrelated instructions do not reduce the wallet's available balance
    expect(required).toBe(0n);
  });

  it("counts seeded account creation", () => {
    // Given a seeded account funded by the wallet
    const wallet = Keypair.generate().publicKey;
    const account = Keypair.generate().publicKey;
    const transaction = new Transaction().add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        newAccountPubkey: account,
        basePubkey: wallet,
        seed: "prism",
        lamports: 3_000_000,
        space: 0,
        programId: SystemProgram.programId,
      }),
    );

    // When the transaction budget is calculated
    const required = getWalletSystemLamportsRequired(transaction.instructions, wallet);

    // Then the seeded account funding is included
    expect(required).toBe(3_000_000n);
  });

  it("fails closed when a System Program instruction cannot be decoded", () => {
    // Given malformed System Program instruction data
    const wallet = Keypair.generate().publicKey;
    const instruction = new TransactionInstruction({
      keys: [],
      programId: SystemProgram.programId,
      data: Buffer.alloc(0),
    });

    // When the transaction budget is calculated
    // Then malformed funding data is rejected instead of being undercounted
    expect(() => getWalletSystemLamportsRequired([instruction], wallet)).toThrow(
      "Unable to decode System Program instruction",
    );
  });
});
