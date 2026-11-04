// 链接统一出口（MD2)：正文链接一律经此打开系统浏览器，呈现层禁止裸
// Linking.openURL 散落。协议白名单 http / https / mailto——其余 scheme
// (javascript: / file: / 自定义 scheme 等）一律不响应、不抛错，返回 false。
// 解析层（markdown-it validateLink）已拦截 javascript: 等危险协议不成链接，
// 本出口是第二道保险：任何来源的 href 都只从这里出网。
import * as Linking from 'expo-linking';

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
]);

/** 打开外链（成功 true；协议不在白名单 / URL 非法 / 原生异常一律 false) */
export async function openLink(url: string): Promise<boolean> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(protocol)) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
