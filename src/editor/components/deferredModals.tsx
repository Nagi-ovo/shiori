import type { ComponentProps } from "react";
import { deferModal } from "./deferModal";
// Type-only: these imports are erased, so the modules stay out of the entry
// bundle. The dynamic imports below are the only runtime references.
import type { ChangelogModal as ChangelogModalImpl } from "./ChangelogModal";
import type { UpdateModal as UpdateModalImpl } from "./UpdateModal";
import type { SettingsPanel as SettingsPanelImpl } from "./SettingsPanel";

// The changelog inlines three full-language Markdown files (~140KB) and
// the update dialog shares its Markdown renderer; settings is a 34KB panel
// most sessions never open. None of them belongs in the first paint.

export const ChangelogModal = deferModal<
  ComponentProps<typeof ChangelogModalImpl>
>(async () => (await import("./ChangelogModal")).ChangelogModal);

export const UpdateModal = deferModal<ComponentProps<typeof UpdateModalImpl>>(
  async () => (await import("./UpdateModal")).UpdateModal,
);

export const SettingsPanel = deferModal<
  ComponentProps<typeof SettingsPanelImpl>
>(
  async () => (await import("./SettingsPanel")).SettingsPanel,
  (props) => props.open,
);
