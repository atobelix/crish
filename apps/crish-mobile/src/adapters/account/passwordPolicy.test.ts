import { evaluatePassword, PASSWORD_MAX_LENGTH } from './passwordPolicy';

describe('passwordPolicy（与账号中心同源）', () => {
  it('长度与明显弱口令拒绝', () => {
    expect(evaluatePassword('Ab1!')).toMatchObject({
      acceptable: false,
      reason: 'too_short',
    });
    expect(evaluatePassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatchObject(
      { acceptable: false, reason: 'too_long' }
    );
    expect(evaluatePassword('12345678')).toMatchObject({
      acceptable: false,
      reason: 'too_weak',
    });
    expect(evaluatePassword('abcdabcd')).toMatchObject({
      acceptable: false,
      reason: 'too_weak',
    });
    expect(evaluatePassword('password123')).toMatchObject({
      acceptable: false,
      reason: 'too_weak',
    });
    expect(
      evaluatePassword('hesonflowbit', { email: 'hesonflowbit@flowbit.me' })
    ).toMatchObject({ acceptable: false, reason: 'too_weak' });
  });

  it('强度分级', () => {
    expect(evaluatePassword('abcdefgz')).toEqual({
      acceptable: true,
      strength: 'weak',
    });
    expect(evaluatePassword('abcdefg1')).toEqual({
      acceptable: true,
      strength: 'medium',
    });
    expect(evaluatePassword('Str0ng-Passw0rd!')).toEqual({
      acceptable: true,
      strength: 'strong',
    });
  });
});
