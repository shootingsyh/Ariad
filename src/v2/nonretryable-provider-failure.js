// Configuration and account entitlement errors cannot be repaired by rerunning the same role.
export function isNonretryableProviderFailure(failure) {
  const message = String(failure ?? '');
  return /MODEL_PROVIDER_UNAVAILABLE|model is not supported when using Codex with a ChatGPT account|model not found|unsupported model|unknown model/i.test(message);
}
