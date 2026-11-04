/**
 * 设置一级分区「登录设备」：已整合至统一「设备管理」页（SettingsDevicesTab）。
 * 此处作为透明代理保留，确保深链与历史路由访问无损。
 */
import React from 'react';
import { SettingsDevicesTab } from './SettingsDevicesTab';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsLoginDevicesTab: React.FC<Props> = (props) => {
  return <SettingsDevicesTab {...props} />;
};
