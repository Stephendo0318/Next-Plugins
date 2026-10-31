import Page from '@revenge-mod/components/Page'
import TableRowAssetIcon from '@revenge-mod/components/TableRowAssetIcon'
import { Design } from '@revenge-mod/discord/design'
import { DefaultSettings } from './shared'
import type { PluginSettingsComponent } from '@revenge-mod/plugins/types'
import type { ComponentProps } from 'react'
import type { Settings } from './shared'

const { Stack, TableRadioGroup, TableRadioRow, TableRowGroup, TableSwitchRow } =
	Design

type SettingComponentProps = ComponentProps<
	PluginSettingsComponent<{ jsonStorage: Settings }>
>

export default function SettingsComponent({
	api: { jsonStorage: storage },
}: SettingComponentProps) {
	const { enabled, button } = { ...DefaultSettings, ...storage.use() }

	return (
		<Page>
			<Stack spacing={24}>
				<TableRowGroup>
					<TableSwitchRow
						icon={<TableRowAssetIcon name="KeyboardIcon" />}
						label="Silent typing"
						subLabel="Hide your typing indicator from others."
						value={enabled}
						onValueChange={enabled => storage.set({ enabled })}
					/>
				</TableRowGroup>
				<TableRadioGroup
					title="Toggle Button"
					defaultValue={button}
					onChange={(button: Settings['button']) => storage.set({ button })}
				>
					<TableRadioRow label="Hidden" value="none" />
					<TableRadioRow
						label="Left"
						subLabel="Next to the attachments button."
						value="left"
					/>
					<TableRadioRow
						label="Right"
						subLabel="Next to the emoji button."
						value="right"
					/>
				</TableRadioGroup>
			</Stack>
		</Page>
	)
}
