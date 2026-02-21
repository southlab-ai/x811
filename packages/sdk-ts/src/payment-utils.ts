/**
 * x811 Protocol — Payment utilities for pre-flight checks and fee-split payments.
 *
 * Provides:
 *   - preflightBalanceCheck() — verify sufficient USDC before attempting payment
 *   - executePaymentWithFee() — two-transfer flow: provider payment + protocol fee
 */

import type { PaymentPayload } from "@x811/core";
import type { WalletAdapter, WalletPayParams } from "./wallet-adapter.js";
import { isValidPaymentAddress } from "./wallet-adapter.js";

// ---------------------------------------------------------------------------
// Pre-flight balance check
// ---------------------------------------------------------------------------

/**
 * Verify the wallet has enough USDC to cover the total cost.
 * Throws with a descriptive error if the balance is insufficient.
 *
 * @param wallet  - The wallet adapter to check.
 * @param totalCost - Required USDC amount (human-readable, e.g., 0.03075).
 */
export async function preflightBalanceCheck(
  wallet: WalletAdapter,
  totalCost: number,
): Promise<void> {
  const balance = await wallet.getBalance();
  if (balance < totalCost) {
    throw new Error(
      `X811-5010: Insufficient USDC balance. Have: $${balance}, Need: $${totalCost}. Fund wallet: ${wallet.address}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fee-split payment
// ---------------------------------------------------------------------------

export interface FeePaymentParams {
  /** Wallet adapter to execute payments through. */
  wallet: WalletAdapter;
  /** Provider's checksummed Ethereum address. */
  providerAddress: string;
  /** x811 treasury address for protocol fee collection. null = skip fee. */
  treasuryAddress: string | null;
  /** USDC amount to pay the provider (e.g., "0.03"). */
  price: string;
  /** Protocol fee amount in USDC (e.g., "0.00075"). */
  protocolFee: string;
  /** Provider's DID. */
  providerDid: string;
  /** Request interaction ID. */
  requestId: string;
  /** Offer interaction ID. */
  offerId: string;
}

/**
 * Execute a two-step payment: provider transfer + optional protocol fee transfer.
 *
 * Flow:
 *   1. Pre-flight balance check (price + protocolFee if treasury is set).
 *   2. Transfer `price` USDC to `providerAddress` → main tx_hash.
 *   3. If `treasuryAddress` is provided: transfer `protocolFee` USDC → fee_tx_hash.
 *      - If the fee transfer fails, log the error but still return success
 *        (the provider already received their payment).
 *   4. Return a PaymentPayload with both hashes.
 *
 * @throws {Error} X811-5010 if balance is insufficient.
 * @throws {Error} X811-5001 if a payment address is invalid.
 * @throws {Error} X811-5020 if the provider payment fails.
 */
export async function executePaymentWithFee(
  params: FeePaymentParams,
): Promise<PaymentPayload> {
  const {
    wallet,
    providerAddress,
    treasuryAddress,
    price,
    protocolFee,
    providerDid,
    requestId,
    offerId,
  } = params;

  // --- Validate addresses ---------------------------------------------------
  if (!isValidPaymentAddress(providerAddress)) {
    throw new Error(`X811-5001: Invalid provider payment address: ${providerAddress}`);
  }
  if (treasuryAddress !== null && !isValidPaymentAddress(treasuryAddress)) {
    throw new Error(`X811-5001: Invalid treasury payment address: ${treasuryAddress}`);
  }

  // --- Pre-flight balance check ---------------------------------------------
  const priceNum = parseFloat(price);
  const feeNum = parseFloat(protocolFee);
  const totalCost = treasuryAddress !== null ? priceNum + feeNum : priceNum;

  await preflightBalanceCheck(wallet, totalCost);

  // --- Transfer 1: pay the provider -----------------------------------------
  const providerPayParams: WalletPayParams = {
    to_address: providerAddress,
    amount: price,
    providerDid,
    requestId,
    offerId,
  };

  let paymentResult: PaymentPayload;
  try {
    paymentResult = await wallet.pay(providerPayParams);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`X811-5020: Provider payment failed: ${msg}`);
  }

  // --- Transfer 2: protocol fee (optional, best-effort) ---------------------
  let feeTxHash: string | undefined;

  if (treasuryAddress !== null && feeNum > 0) {
    const feePayParams: WalletPayParams = {
      to_address: treasuryAddress,
      amount: protocolFee,
      providerDid,
      requestId,
      offerId,
    };

    try {
      const feeResult = await wallet.pay(feePayParams);
      feeTxHash = feeResult.tx_hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[x811:payment] Protocol fee transfer failed (provider already paid): ${msg}\n`,
      );
      // fee_tx_hash stays undefined — provider payment is not rolled back
    }
  }

  // --- Build final PaymentPayload -------------------------------------------
  return {
    ...paymentResult,
    fee_tx_hash: feeTxHash,
  };
}
