# auto-fishing for Private Servers

> Fully updated for **TERA v100.02** with a modular codebase, safer packet handling and additional QoL commands.

This module automates fishing on private servers by:

- Throwing and re-throwing the fishing rod with human-like delays
- Detecting bites, playing and completing the mini-game
- Auto-crafting configured bait recipes when bait runs out
- Dismantling common and/or golden fish when inventory space gets tight
- Integrating with [`auto-nego`](https://github.com/Owyn/auto-nego) to answer broker deals mid-fishing
- Integrating with [`tera-notifier`](https://github.com/SerenTera/tera-notifier) for AFK notifications

The module now auto-detects protocol versions used in v100.02 and gracefully falls back for earlier clients. All state is kept per-character in `./saves/<character>-<server>.json`.

## Usage

| Command | Description |
| ------- | ----------- |
| `fish` / `!fish` | Toggle auto-fishing on/off. When enabled the module guides you through providing a bait recipe and the first cast. |
| `fish save` | Persist the current bait recipe and dismantle settings for this character. |
| `fish load` | Reload the saved configuration from disk (helpful when editing JSON manually). |
| `fish reset` | Clear any saved recipe/bait and restore default dismantle options. |
| `fish list` | Display the currently active recipe, bait and dismantle preferences. |
| `fish dismantle` | Toggle dismantling of common fish (default **ON**). |
| `fish gold` | Toggle dismantling of golden fish (default **OFF**). |
| `fish status` | Show runtime statistics such as elapsed time and fish caught per tier. |
| `fish stop` | Immediately stop fishing without triggering notifier popups. |

### Getting started

1. Equip your fishing rod and place one stack of the bait you want to keep reusing in your inventory.
2. Type `fish` (or `!fish`). If you intend to auto-craft bait, click the craft button for the recipe once when prompted.
3. Cast your rod manually once. After the first bite the module records your rod, starts the timer, and takes over.
4. Optionally, use `fish save` so the recipe/dismantle settings load automatically next login.

### Behaviour highlights

- Stops entirely if you leave the fishing area, teleport, hit the dismantled fishlet cap, or run out of materials.
- Respects character movement and negotiations; it will finish ongoing broker deals before resuming.
- Keeps human-like randomised action delays to reduce detection risk.
- Writes detailed debug information to the proxy console when unexpected inventory states are encountered.

## Configuration files

Per-character settings live under the `saves/` directory. An example entry looks like:

```json
{
    "dismantleFish": true,
    "dismantleFishGold": false,
    "craftId": 204100,
    "baitId": 206001
}
```

You normally should not edit `baitId` manually—the module adjusts it when you pick a recipe—but the option is available for advanced setups.

## Notes

- The module gracefully stops when you accumulate 10,000 fishlets. If you want to delete fishlets automatically, combine it with [Fish-Deleter](https://github.com/Lambda11/Fish-Deleter).
- Opcode definitions are expected to be provided by the proxy pack you are using. The module attempts multiple packet versions (including the latest KR v100.02 values) before giving up.
- Do **not** decrease the delays unless you understand the ban risk. If you insist on tweaking, set `disableAutoUpdate` to `true` in `module.json` and adjust the delay constants in `src/constants.js`.
- Always keep a few open inventory slots and enough fish fillets for bait crafting before enabling automation.

Happy fishing!
