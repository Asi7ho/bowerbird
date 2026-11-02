# Plugin Builder

Describe a plugin, and an AI writes it for you to try, then keep or discard.

Open its panel, describe the plugin you want, and press Generate. You get a plain-language summary first: what the plugin is, what it adds (a panel, a tool, a view, a command, and so on, detected from the code itself), and what it can do, with each permission explained in plain language. You do not need to read the code to try the plugin — the code is behind a "Show code" button, for people who want it.

If it is not right, write what to change in the "Not quite right?" box and press Refine. Press Try it to run the plugin without installing it, then Keep it or Discard it.

## Try, then keep or discard

Try runs the plugin in memory only. Nothing is written to disk, and Discard (or quitting the app) removes it completely. While you are trying a plugin, its panel, tool or view works as it would if it were installed, and the Builder panel shows a banner with Keep it and Discard.

A trial is not a security sandbox, and the panel says so plainly while a trial is running: the plugin still runs in the app like any plugin, with the same permission checks. What trying protects you from is permanence — a plugin being tried cannot install other plugins, and cannot create, rename, switch or delete boards. If it changes your board, you can undo that with Ctrl+Z / Cmd+Z. If you discard a plugin that added cards, those cards stay as placeholders — delete them if you don't want them.

Keep installs the plugin to your user plugins folder, then activates it at once, with no restart, and it appears in Settings → Plugins like any other plugin. Install without trying is still there, for people who don't want to try first. Install refuses to overwrite an existing plugin with the same id, and is blocked in demo mode.

## Bring your own AI

There is no AI built into Bowerbird, and no key is collected anywhere else. You bring your own provider, model and key, in Settings → Plugin settings → Plugin Builder.

- Provider: an OpenAI-compatible address, for example `https://api.openai.com/v1`. A local model server works too, for example `http://localhost:11434/v1`, and needs no key.
- Model: whatever your provider offers, for example `gpt-4o-mini`.
- Key: entered in Settings, saved once in secure storage — encrypted by your system's keychain where the system can encrypt it, plain where it cannot, as the Settings status says — and only ever sent to the provider you set. Forget in Settings deletes it.

The AI only writes plugins, using the plugin api. It never sees or changes the core of the app, and a request that would need a core change gets the closest plugin-only version instead.

Calls are charged by your provider, at whatever its price is. Bowerbird adds no charge.
