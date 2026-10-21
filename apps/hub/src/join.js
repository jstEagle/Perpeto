/**
 * A join code: one paste-able string carrying the hub URL, the certificate fingerprint to pin (when the hub serves its
 * own self-signed certificate) and the one-time enrollment code. `pj1_` plus base64url JSON, so it survives shells.
 */
export const encodeJoinCode = ({ url, fingerprint, code }) => `pj1_${Buffer.from(JSON.stringify({ url, ...(fingerprint ? { fingerprint } : {}), code })).toString('base64url')}`;
