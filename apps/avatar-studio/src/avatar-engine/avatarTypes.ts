export type AvatarCameraFrame = 'circle' | 'rounded' | 'square'

export interface AvatarViewState {
  readonly pitch: number
  readonly positionX: number
  readonly positionY: number
  readonly roll: number
  readonly scale: number
  readonly yaw: number
}

export type AvatarInteractionMode = 'move' | 'rotate'

export interface AvatarDropShadowStyle {
  readonly color: string
  readonly direction: number
  readonly distance: number
  readonly opacity: number
  readonly softness: number
}

export interface AvatarOutlineStyle {
  readonly color: string
  readonly opacity: number
  readonly width: number
}
