export const requireLocalAuthority = () => {
  if (process.env.AIDLC_FLEET_URL) throw new Error("Fleet authority is configured; use remote-state.mjs instead of local lifecycle scripts");
};
