import { ToastActionCreators } from '@revenge-mod/discord/actions'
import { Tokens } from '@revenge-mod/discord/common/tokens'
import { Design } from '@revenge-mod/discord/design'
import { onFluxEventDispatched } from '@revenge-mod/discord/flux'
import {
	getModuleWithImportedPath,
	lookupModuleWithImportedPath,
} from '@revenge-mod/discord/utils/modules/finders'
import { lookupGeneratedIconComponent } from '@revenge-mod/utils/discord'
import { proxify } from '@revenge-mod/utils/proxy'
import { findInReactFiber } from '@revenge-mod/utils/react'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import SettingsComponent from './settings'
import { DefaultSettings } from './shared'
import type { JsonStorage } from '@revenge-mod/json-storage'
import type { FC, MemoExoticComponent, ReactElement, ReactNode } from 'react'
import type { ImageStyle, StyleProp } from 'react-native'
import type { Settings } from './shared'

let storage: JsonStorage<Settings>

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: {
		load: true,
		default: DefaultSettings,
	},
	start({ cleanup, jsonStorage }) {
		storage = jsonStorage

		cleanup(
			onFluxEventDispatched('TYPING_START_LOCAL', payload =>
				(storage.cache?.enabled ?? DefaultSettings.enabled)
					? undefined
					: payload,
			),
			getModuleWithImportedPath<{ default: MemoExoticComponent<FC> }>(
				'modules/chat_input/native/action_buttons/ChatInputActions.tsx',
				({ default: ChatInputActions }) => {
					cleanup(
						patchMemoType(ChatInputActions, tree =>
							insertButton(tree, 'left'),
						),
					)
				},
			),
			getModuleWithImportedPath<{ default: MemoExoticComponent<FC> }>(
				'modules/chat_input/native/action_buttons/ChatInputRightActions.tsx',
				({ default: ChatInputRightActions }) => {
					cleanup(
						patchMemoType(ChatInputRightActions, tree =>
							insertButton(tree, 'right'),
						),
					)
				},
			),
		)
	},
	SettingsComponent,
})

// Same element every render, so it can be found again in cached trees
const button = <SilentTypingButton key="silent-typing" />

/**
 * Wraps a memo component's inner render function with a plain function
 * (no Proxy), so a non-function `type` can never blow up at render time.
 * Returns an unpatch function.
 */
function patchMemoType(
	memo: MemoExoticComponent<FC>,
	patch: (tree: ReactElement) => ReactElement,
): () => void {
	const original = (memo as unknown as { type?: unknown } | undefined)?.type

	if (typeof original !== 'function') {
		console.warn(
			'[silent-typing] Skipping patch, memo.type is not a function:',
			typeof original,
		)
		return () => {}
	}

	const render = original as (...args: unknown[]) => unknown

	function patched(this: unknown, ...args: unknown[]) {
		const tree = render.apply(this, args)
		return tree ? patch(tree as ReactElement) : tree
	}

	;(patched as { displayName?: string }).displayName =
		(original as { displayName?: string }).displayName ??
		(original as { name?: string }).name

	;(memo as unknown as { type: unknown }).type = patched

	return () => {
		const m = memo as unknown as { type: unknown }
		if (m.type === patched) m.type = original
	}
}

function insertButton(tree: ReactElement, side: Settings['button']) {
	const node = findInReactFiber(
		tree,
		(node): node is { props: { children: ReactNode[] } } =>
			Array.isArray(node.props?.children),
	)
	if (!node) return tree

	const { children } = node.props
	const index = children.indexOf(button)
	if (index !== -1) children.splice(index, 1)

	if ((storage.cache?.button ?? DefaultSettings.button) === side) {
		// Left goes after the attachments button, right goes before the emoji button
		if (side === 'left') children.push(button)
		else children.unshift(button)
	}

	return tree
}

const ChatInputActionButtonPath =
	'modules/chat_input/native/action_buttons/ChatInputActionButton.tsx'

function SilentTypingButton() {
	const { enabled } = { ...DefaultSettings, ...storage.use() }
	const KeyboardIcon = lookupGeneratedIconComponent('KeyboardIcon')
	const [ChatInputActionButton, setChatInputActionButton] = useState(
		() =>
			lookupModuleWithImportedPath<ChatInputActionButtonModule>(
				ChatInputActionButtonPath,
			)[0]?.default,
	)

	// Discord requires it inline, so it may not be initialized on first render
	useEffect(() => {
		if (ChatInputActionButton) return

		return getModuleWithImportedPath<ChatInputActionButtonModule>(
			ChatInputActionButtonPath,
			({ default: Button }) => setChatInputActionButton(() => Button),
		)
	}, [ChatInputActionButton])

	if (!ChatInputActionButton || !KeyboardIcon) return null

	return (
		<ChatInputActionButton
			accessibilityLabel="Toggle silent typing"
			accessibilityState={{ checked: enabled }}
			IconComponent={enabled ? KeyboardOffIcon : KeyboardIcon}
			onPress={() => {
				storage.set({ enabled: !enabled })
				ToastActionCreators.open(`REVENGE_SILENT_TYPING_${enabled}`, {
					icon: KeyboardIcon,
					text: `Silent typing ${enabled ? 'disabled' : 'enabled'}`,
				})
			}}
		/>
	)
}

function KeyboardOffIcon(props: IconProps) {
	const styles = useStyles()

	const KeyboardIcon = lookupGeneratedIconComponent('KeyboardIcon')
	if (!KeyboardIcon) return null
	const { width = 24, height = 24 } = StyleSheet.flatten(
		props.style,
	) as ImageStyle & {
		width?: number
		height?: number
	}
	const length = Math.hypot(width, height) * 0.85

	return (
		<View>
			<KeyboardIcon {...props} />
			<View
				style={[
					styles.slash,
					{
						width: length,
						top: (height - SlashHeight) / 2,
						left: (width - length) / 2,
					},
				]}
			/>
		</View>
	)
}

const SlashBorderWidth = 2
// 2px line plus the border on each side
const SlashHeight = 2 + SlashBorderWidth * 2

const useStyles = proxify(() =>
	Design.createStyles({
		slash: {
			position: 'absolute',
			height: SlashHeight,
			backgroundColor: Tokens.default.colors.ICON_FEEDBACK_CRITICAL,
			borderWidth: SlashBorderWidth,
			borderColor: Tokens.default.colors.MOBILE_CHATINPUT_BACKGROUND_DEFAULT,
			borderRadius: SlashHeight / 2,
			transform: [{ rotate: '-45deg' }],
		},
	}),
)

// Also gets size: 'custom', which BaseIconImage's types don't list
interface IconProps {
	style: StyleProp<ImageStyle>
}

interface ChatInputActionButtonModule {
	default: FC<ChatInputActionButtonProps>
}

interface ChatInputActionButtonProps {
	accessibilityLabel: string
	accessibilityState?: { checked?: boolean }
	IconComponent: FC<IconProps>
	onPress(): void
}
