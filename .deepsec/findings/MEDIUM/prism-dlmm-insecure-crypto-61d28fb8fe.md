# [MEDIUM] Wallet secret key stored unencrypted at rest

**File:** [`cli/wallet.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/wallet.ts#L31-L135) (lines 31, 32, 33, 35, 131, 132, 133, 135)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `insecure-crypto`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The Ed25519 secret key (which controls real SOL and tokens for live trading) is written as a plaintext JSON number array to ~/.config/prism/wallet.json (lines 31-37 for generate, 131-137 for import). While file permissions are correctly set to 0o600, the key material has no encryption at rest. Any file-read primitive elsewhere in the system (path traversal, backup exfiltration, cloud sync leak, same-user malware, disk image theft) exposes the full signing key without needing to defeat a passphrase or OS keychain. The project's own threat model identifies 'Wallet key theft' as the highest-impact threat. This is the standard pattern for Solana CLI tools (solana-keygen), but modern best practice (EIP-2335 keystores, OS secret stores) encrypts keys at rest.

## Recommendation

Encrypt the secret key at rest using a user-provided passphrase (e.g., scrypt/argon2 KDF + AES-256-GCM, similar to EIP-2335 keystores) or integrate with the OS keychain (macOS Keychain, libsecret on Linux). At minimum, document the risk clearly and recommend hardware wallet or OS-level disk encryption for users running in live mode.

## Recent committers (`git log`)

- irfandi marsya <join.mantap@gmail.com> (2026-06-10)
