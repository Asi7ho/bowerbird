# Plugin Builder

A chat panel. Describe a plugin, and an AI builds it and puts it straight into the sandbox for you to try.

Open its panel and send a message describing the plugin you want. The assistant replies with a plain-language summary: what the plugin is, what it adds (a panel, a tool, a view, a command, and so on, detected from the code itself), and what it can do, with each permission explained in plain language. There is no code to read. If it is not right, just send another message saying what to change.

After a generation, the plugin is already running in the sandbox, and the assistant's message has two buttons: Install Plugin and Clean Sandbox.

## Install Plugin or Clean Sandbox

A generation runs in the sandbox in memory only. Nothing is written to disk, and Clean Sandbox (or quitting the app) removes it completely. While it is running, its panel, tool or view works as it would if it were installed.

A sandbox run is not a security sandbox: the plugin still runs in the app like any plugin, with the same permission checks. What the sandbox protects you from is permanence — a plugin in the sandbox cannot install other plugins, and cannot create, rename, switch or delete boards. If it changes your board, you can undo that with Ctrl+Z / Cmd+Z. If you clean a sandbox plugin that added cards, those cards stay as placeholders — delete them if you don't want them.

Install Plugin installs the plugin to your user plugins folder, then activates it at once, with no restart, and it appears in Settings → Plugins like any other plugin. Install refuses to overwrite an existing plugin with the same id, and is blocked in demo mode.

## Bring your own AI

There is no AI built into Bowerbird, and no key is collected anywhere else. You bring your own provider, model and key, in Settings → Plugin settings → Plugin Builder.

- Provider: an OpenAI-compatible address, for example `https://api.openai.com/v1`. A local model server works too, for example `http://localhost:11434/v1`, and needs no key.
- Model: whatever your provider offers, for example `gpt-4o-mini`.
- Key: entered in Settings, saved once in secure storage — encrypted by your system's keychain where the system can encrypt it, plain where it cannot, as the Settings status says — and only ever sent to the provider you set. Forget in Settings deletes it.

The AI only writes plugins, using the plugin api. It never sees or changes the core of the app, and a request that would need a core change gets the closest plugin-only version instead.

Calls are charged by your provider, at whatever its price is. Bowerbird adds no charge.
