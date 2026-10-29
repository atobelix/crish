// 注销账号：服务端 409 业务拒绝映射为中文文案。
import { AccountApiError } from './accountApi';
import { deleteAccountByConfirmEmail } from './accountService';
import { deleteAccount } from './accountDeletion';

jest.mock('./accountService', () => ({
  deleteAccountByConfirmEmail: jest.fn(),
}));

const deleteMock = jest.mocked(deleteAccountByConfirmEmail);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('deleteAccount', () => {
  it('成功后返回 ok', async () => {
    deleteMock.mockResolvedValue(undefined);
    await expect(deleteAccount('a@b.co')).resolves.toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith('a@b.co');
  });

  it('法务保全 409 映射为中文提示', async () => {
    deleteMock.mockRejectedValue(
      new AccountApiError(409, 'legal_hold', 'legal hold')
    );
    await expect(deleteAccount('a@b.co')).resolves.toEqual({
      ok: false,
      reason: 'failed',
      message: '账号处于法务保全状态，暂时无法注销',
    });
  });

  it('有余额 / 付费套餐 409 映射为中文提示', async () => {
    deleteMock.mockRejectedValue(
      new AccountApiError(409, 'account_has_balance', 'balance')
    );
    await expect(deleteAccount('a@b.co')).resolves.toEqual({
      ok: false,
      reason: 'failed',
      message: '账号仍有余额或付费套餐，暂时无法注销',
    });
  });

  it('邮箱不一致提示重新确认', async () => {
    deleteMock.mockRejectedValue(
      new AccountApiError(400, 'email_mismatch', 'mismatch')
    );
    await expect(deleteAccount('a@b.co')).resolves.toEqual({
      ok: false,
      reason: 'failed',
      message: '确认邮箱与账号邮箱不一致',
    });
  });
});
