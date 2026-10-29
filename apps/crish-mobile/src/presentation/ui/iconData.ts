// Hugeicons 图标数据（按需逐文件导入，避免把整个图标库拖进 bundle）。
import type { IconSvgElement } from '@hugeicons/react-native';
import Activity01Icon from '@hugeicons/core-free-icons/Activity01Icon';
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon';
import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon';
import Camera01Icon from '@hugeicons/core-free-icons/Camera01Icon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import CheckIcon from '@hugeicons/core-free-icons/CheckIcon';
import CheckmarkCircle01Icon from '@hugeicons/core-free-icons/CheckmarkCircle01Icon';
import ChevronDownIcon from '@hugeicons/core-free-icons/ChevronDownIcon';
import ChevronLeftIcon from '@hugeicons/core-free-icons/ChevronLeftIcon';
import ChevronRightIcon from '@hugeicons/core-free-icons/ChevronRightIcon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import ComputerIcon from '@hugeicons/core-free-icons/ComputerIcon';
import ComputerTerminal01Icon from '@hugeicons/core-free-icons/ComputerTerminal01Icon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import File01Icon from '@hugeicons/core-free-icons/File01Icon';
import FileCodeIcon from '@hugeicons/core-free-icons/FileCodeIcon';
import FileImageIcon from '@hugeicons/core-free-icons/FileImageIcon';
import FileTextIcon from '@hugeicons/core-free-icons/FileTextIcon';
import FlashIcon from '@hugeicons/core-free-icons/FlashIcon';
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon';
import FolderOpenIcon from '@hugeicons/core-free-icons/FolderOpenIcon';
import GitBranchIcon from '@hugeicons/core-free-icons/GitBranchIcon';
import HistoryIcon from '@hugeicons/core-free-icons/HistoryIcon';
import Home01Icon from '@hugeicons/core-free-icons/Home01Icon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import KeyboardIcon from '@hugeicons/core-free-icons/KeyboardIcon';
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon';
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon';
import Menu01Icon from '@hugeicons/core-free-icons/Menu01Icon';
import MessageMultiple01Icon from '@hugeicons/core-free-icons/MessageMultiple01Icon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import Notification01Icon from '@hugeicons/core-free-icons/Notification01Icon';
import PauseIcon from '@hugeicons/core-free-icons/PauseIcon';
import PencilEdit02Icon from '@hugeicons/core-free-icons/PencilEdit02Icon';
import PinIcon from '@hugeicons/core-free-icons/PinIcon';
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon';
import PlusSignIcon from '@hugeicons/core-free-icons/PlusSignIcon';
import QrCode01Icon from '@hugeicons/core-free-icons/QrCode01Icon';
import Refresh01Icon from '@hugeicons/core-free-icons/Refresh01Icon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import SentIcon from '@hugeicons/core-free-icons/SentIcon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import Shield01Icon from '@hugeicons/core-free-icons/Shield01Icon';
import ShieldOffIcon from '@hugeicons/core-free-icons/ShieldOffIcon';
import SlidersHorizontalIcon from '@hugeicons/core-free-icons/SlidersHorizontalIcon';
import SmartPhone01Icon from '@hugeicons/core-free-icons/SmartPhone01Icon';
import SortByDown01Icon from '@hugeicons/core-free-icons/SortByDown01Icon';
import StopIcon from '@hugeicons/core-free-icons/StopIcon';
import UserCircleIcon from '@hugeicons/core-free-icons/UserCircleIcon';
import Wifi01Icon from '@hugeicons/core-free-icons/Wifi01Icon';
import WifiOff01Icon from '@hugeicons/core-free-icons/WifiOff01Icon';
import Wrench01Icon from '@hugeicons/core-free-icons/Wrench01Icon';
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon';
import ViewOffIcon from '@hugeicons/core-free-icons/ViewOffIcon';

export type IconName =
  | 'home'
  | 'messages'
  | 'shield'
  | 'folder'
  | 'settings'
  | 'bell'
  | 'search'
  | 'send'
  | 'refresh'
  | 'wifi'
  | 'wifi-off'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'x'
  | 'check'
  | 'check-circle'
  | 'alert-triangle'
  | 'alert-circle'
  | 'info'
  | 'clock'
  | 'play'
  | 'pause'
  | 'stop'
  | 'terminal'
  | 'more'
  | 'plus'
  | 'smartphone'
  | 'user'
  | 'monitor'
  | 'qr-code'
  | 'keyboard'
  | 'log-out'
  | 'trash'
  | 'file'
  | 'file-text'
  | 'file-code'
  | 'file-image'
  | 'folder-open'
  | 'git-branch'
  | 'wrench'
  | 'zap'
  | 'copy'
  | 'link'
  | 'shield-off'
  | 'sliders'
  | 'sort'
  | 'pin'
  | 'activity'
  | 'menu'
  | 'new-chat'
  | 'history'
  | 'arrow-up'
  | 'eye'
  | 'eye-off'
  | 'camera';

export const ICON_DATA: Record<IconName, IconSvgElement> = {
  home: Home01Icon,
  messages: MessageMultiple01Icon,
  shield: Shield01Icon,
  folder: Folder01Icon,
  settings: Settings01Icon,
  bell: Notification01Icon,
  search: Search01Icon,
  send: SentIcon,
  refresh: Refresh01Icon,
  wifi: Wifi01Icon,
  'wifi-off': WifiOff01Icon,
  'chevron-left': ChevronLeftIcon,
  'chevron-right': ChevronRightIcon,
  'chevron-down': ChevronDownIcon,
  'arrow-left': ArrowLeft01Icon,
  'arrow-right': ArrowRight01Icon,
  x: Cancel01Icon,
  check: CheckIcon,
  'check-circle': CheckmarkCircle01Icon,
  'alert-triangle': Alert02Icon,
  'alert-circle': AlertCircleIcon,
  info: InformationCircleIcon,
  clock: Clock01Icon,
  play: PlayIcon,
  pause: PauseIcon,
  stop: StopIcon,
  terminal: ComputerTerminal01Icon,
  more: MoreHorizontalIcon,
  plus: PlusSignIcon,
  smartphone: SmartPhone01Icon,
  user: UserCircleIcon,
  monitor: ComputerIcon,
  'qr-code': QrCode01Icon,
  keyboard: KeyboardIcon,
  'log-out': Logout01Icon,
  trash: Delete02Icon,
  file: File01Icon,
  'file-text': FileTextIcon,
  'file-code': FileCodeIcon,
  'file-image': FileImageIcon,
  'folder-open': FolderOpenIcon,
  'git-branch': GitBranchIcon,
  wrench: Wrench01Icon,
  zap: FlashIcon,
  copy: Copy01Icon,
  link: Link01Icon,
  'shield-off': ShieldOffIcon,
  sliders: SlidersHorizontalIcon,
  sort: SortByDown01Icon,
  pin: PinIcon,
  activity: Activity01Icon,
  menu: Menu01Icon,
  'new-chat': PencilEdit02Icon,
  history: HistoryIcon,
  'arrow-up': ArrowUp01Icon,
  eye: ViewIcon,
  'eye-off': ViewOffIcon,
  camera: Camera01Icon,
};
