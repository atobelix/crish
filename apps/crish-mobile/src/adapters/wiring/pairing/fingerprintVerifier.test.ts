import {
  fingerprintsAgree,
  isValidTlsFingerprint,
  verifyStoredFingerprint,
} from './fingerprintVerifier';

describe('fingerprintVerifier', () => {
  const FP_A = 'a'.repeat(64);
  const FP_B = 'b'.repeat(64);
  const FP_A_UPPER = 'A'.repeat(64);

  describe('fingerprintsAgree', () => {
    it('returns true when challengeFp or okFp is null or undefined (single channel or absent)', () => {
      expect(fingerprintsAgree(null, null)).toBe(true);
      expect(fingerprintsAgree(undefined, undefined)).toBe(true);
      expect(fingerprintsAgree(FP_A, null)).toBe(true);
      expect(fingerprintsAgree(null, FP_A)).toBe(true);
      expect(fingerprintsAgree(FP_A, undefined)).toBe(true);
      expect(fingerprintsAgree(undefined, FP_A)).toBe(true);
      expect(fingerprintsAgree('', FP_A)).toBe(true);
    });

    it('returns true when both channels deliver identical fingerprints (case insensitive, trimmed)', () => {
      expect(fingerprintsAgree(FP_A, FP_A)).toBe(true);
      expect(fingerprintsAgree(FP_A, FP_A_UPPER)).toBe(true);
      expect(fingerprintsAgree(`  ${FP_A}  `, FP_A)).toBe(true);
    });

    it('returns false when both channels deliver different fingerprints', () => {
      expect(fingerprintsAgree(FP_A, FP_B)).toBe(false);
    });
  });

  describe('verifyStoredFingerprint', () => {
    it('handles no stored fingerprint correctly', () => {
      expect(verifyStoredFingerprint(undefined, FP_A)).toEqual({
        ok: true,
        defense: 'no-stored',
      });
    });

    it('handles matching stored fingerprint', () => {
      expect(verifyStoredFingerprint(FP_A, FP_A)).toEqual({
        ok: true,
        defense: 'verified',
      });
    });

    it('handles mismatching stored fingerprint', () => {
      expect(verifyStoredFingerprint(FP_A, FP_B)).toEqual({
        ok: false,
        defense: 'mismatch',
      });
    });
  });

  describe('isValidTlsFingerprint', () => {
    it('validates 64-char hex strings', () => {
      expect(isValidTlsFingerprint(FP_A)).toBe(true);
      expect(isValidTlsFingerprint('short')).toBe(false);
      expect(isValidTlsFingerprint('z'.repeat(64))).toBe(false);
    });
  });
});
