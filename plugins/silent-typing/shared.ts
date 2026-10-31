export interface Settings {
	enabled: boolean
	button: 'none' | 'left' | 'right'
}

export const DefaultSettings: Settings = {
	enabled: true,
	button: 'none',
}
