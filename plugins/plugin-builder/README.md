# Plugin Builder

Describe a plugin, and an AI writes it for you to check and install.

Open its panel, describe the plugin you want, and press Generate. The generated code appears in the panel, with its id, name, description and permissions, for you to read and edit. If it is not right, write what to change in the Steer box and press Refine. Press Check code to validate it, then Install to install it. It activates at once, with no restart, and appears in Settings → Plugins like any other plugin.

## Bring your own AI

There is no AI built into Bowerbird, and no key is collected anywhere else. You bring your own provider, model and key, in Settings → Plugin settings → Plugin Builder.

- Provider: an OpenAI-compatible address, for example `https://api.openai.com/v1`. A local model server works too, for example `http://localhost:11434/v1`, and needs no key.
- Model: whatever your provider offers, for example `gpt-4o-mini`.
- Key: entered in Settings, used only for that session, and never saved to disk, never put in a board, and never sent anywhere except the provider you set. Closing the app, or disabling this plugin, forgets it. Provider and model are saved on this computer, in plugin storage; the key never is.

The AI only writes plugins, using the plugin api. It never sees or changes the core of the app, and a request that would need a core change gets the closest plugin-only version instead.

Calls are charged by your provider, at whatever its price is. Bowerbird adds no charge.

## Installing is trusting the code

A generated plugin runs in the app like any plugin, so read it before you install it. Generation never installs anything on its own. Install refuses to overwrite an existing plugin with the same id, and is blocked in demo mode.
