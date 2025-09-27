'use strict';

const fs = require('fs');
const path = require('path');
const {
  ACTION_DELAY_THROW_ROD,
  ACTION_DELAY_FISH_START,
  ACTION_DELAY_FISH_CATCH,
  DELAY_BASED_ON_FISH_TIER,
  BAIT_RECIPES
} = require('./src/constants');
const {
  rng,
  formatDuration,
  ensureDirectory,
  sumStats,
  deepClone,
  resolveDataFile
} = require('./src/utils');

const PACKET_VERSIONS = Object.freeze({
  S_LOGIN: [17, 16, 15, 14, 13],
  S_ITEMLIST: [4, 3, 2],
  S_INVEN: [22, 21, 20, 19, 18],
  S_LOAD_TOPO: [4, 3],
  S_END_PRODUCE: [2, 1],
  S_START_FISHING_MINIGAME: [1],
  S_FISHING_BITE: [1],
  S_REQUEST_CONTRACT: [1],
  S_CANCEL_CONTRACT: [1],
  S_SYSTEM_MESSAGE: [1],
  S_TRADE_BROKER_DEAL_SUGGESTED: [1],
  C_PLAYER_LOCATION: [6, 5],
  C_USE_ITEM: [4, 3],
  C_START_FISHING_MINIGAME: [2, 1],
  C_END_FISHING_MINIGAME: [3, 2, 1],
  C_START_PRODUCE: [1],
  C_REQUEST_CONTRACT: [1],
  C_CANCEL_CONTRACT: [1],
  C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT: [1],
  C_RQ_COMMIT_DECOMPOSITION_CONTRACT: [1],
  C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION: [1]
});

module.exports = mod => new AutoFishing(mod);

class AutoFishing {
  constructor(mod) {
    this.mod = mod;
    this.command = mod.command;
    this.hasNego = mod.manager && mod.manager.isLoaded('auto-nego');
    this.notifier = this.resolveNotifier();
    this.dismantleContractType = mod.majorPatchVersion >= 85 ? 90 : 89;
    this.savesDir = path.join(__dirname, 'saves');
    ensureDirectory(this.savesDir);

    this.activeVersions = {
      C_START_FISHING_MINIGAME: mod.majorPatchVersion >= 88 ? 2 : 1,
      C_END_FISHING_MINIGAME: mod.majorPatchVersion >= 88 ? 2 : 1,
      C_REQUEST_CONTRACT: 1,
      C_CANCEL_CONTRACT: 1,
      C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT: 1,
      C_RQ_COMMIT_DECOMPOSITION_CONTRACT: 1,
      C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION: 1,
      S_TRADE_BROKER_DEAL_SUGGESTED: 1,
      C_START_PRODUCE: 1,
      C_USE_ITEM: 3
    };

    this.resetState();
    this.registerCommands();
    this.registerHooks();
  }

  resolveNotifier() {
    if (!this.mod.manager || !this.mod.manager.isLoaded('notifier')) return null;
    try {
      if (this.mod.require && this.mod.require.notifier) {
        return this.mod.require.notifier;
      }
      return require('tera-notifier')(this.mod);
    } catch (err) {
      this.mod.error('[auto-fishing] Unable to attach notifier module:', err);
      return null;
    }
  }

  resetState() {
    this.enabled = false;
    this.scanning = false;
    this.tooMuchFishes = false;
    this.triedDismantling = false;
    this.awaitingDismantling = 0;
    this.pendingDeals = [];
    this.theFishes = [];
    this.negoWaiting = false;

    this.playerGameId = 0n;
    this.playerName = '';
    this.serverId = 0;
    this.playerLoc = null;

    this.rodId = 0;
    this.baitId = 0;
    this.craftId = 0;

    this.inventoryItems = [];
    this.inventoryBuffer = [];
    this.inventoryFirstBatch = true;

    this.vContractId = null;
    this.itemsInserted = 0;
    this.statStarted = null;
    this.statFished = 0;
    this.statFishedTiers = {};
    this.currentTier = 0;
    this.leftArea = 0;

    this.settingsFile = null;
    this.settings = {
      dismantleFish: true,
      dismantleFishGold: false,
      craftId: 0,
      baitId: 0
    };
  }

  registerCommands() {
    this.command.add(['fish', '!fish'], {
      $none: () => this.toggle(),
      $default: () => this.command.message('Error (typo?) in command! see README for the list of valid commands'),
      dismantle: () => this.toggleDismantle(false),
      gold: () => this.toggleDismantle(true),
      reset: () => this.resetPreferences(),
      list: () => this.listPreferences(),
      save: () => this.savePreferences(),
      load: () => this.loadPreferences(true),
      status: () => this.printStatus(),
      stop: () => this.stop('Stopped manually.', { notify: false })
    });
  }

  registerHooks() {
    this.hook('S_LOGIN', PACKET_VERSIONS.S_LOGIN, event => this.onLogin(event));
    this.hook('C_PLAYER_LOCATION', PACKET_VERSIONS.C_PLAYER_LOCATION, event => {
      this.playerLoc = event;
    });

    this.hook('S_LOAD_TOPO', PACKET_VERSIONS.S_LOAD_TOPO, () => {
      if (this.enabled) {
        this.stop('You were teleported while fishing, stopping.');
      }
    });

    this.hook('S_START_FISHING_MINIGAME', PACKET_VERSIONS.S_START_FISHING_MINIGAME, event => this.onFishingStart(event));
    this.hook('S_FISHING_BITE', PACKET_VERSIONS.S_FISHING_BITE, event => this.onFishingBite(event));
    this.hook('S_SYSTEM_MESSAGE', PACKET_VERSIONS.S_SYSTEM_MESSAGE, event => this.onSystemMessage(event));

    this.hook('S_ITEMLIST', PACKET_VERSIONS.S_ITEMLIST, event => this.onItemList(event));
    this.hook('S_INVEN', PACKET_VERSIONS.S_INVEN, event => this.onInventory(event));

    this.hook('S_REQUEST_CONTRACT', PACKET_VERSIONS.S_REQUEST_CONTRACT, event => this.onContractRequested(event));
    this.hook('S_CANCEL_CONTRACT', PACKET_VERSIONS.S_CANCEL_CONTRACT, event => this.onContractCancelled(event));
    this.hook('S_END_PRODUCE', PACKET_VERSIONS.S_END_PRODUCE, event => this.onEndProduce(event));
    this.hook('S_TRADE_BROKER_DEAL_SUGGESTED', PACKET_VERSIONS.S_TRADE_BROKER_DEAL_SUGGESTED, event => this.onBrokerDeal(event));

    this.hook('C_START_PRODUCE', PACKET_VERSIONS.C_START_PRODUCE, event => this.onStartProduce(event));
    this.hook('C_USE_ITEM', PACKET_VERSIONS.C_USE_ITEM, event => this.onUseItem(event), { filter: { fake: null } });
  }

  hook(name, versions, handler, options) {
    const versionList = Array.isArray(versions) ? versions : [versions];
    for (const version of versionList) {
      try {
        this.mod.hook(name, version, options || {}, handler);
        this.activeVersions[name] = version;
        return;
      } catch (error) {
        if (version === versionList[versionList.length - 1]) {
          this.mod.warn(`[auto-fishing] Failed to hook ${name}#${version}: ${error.message}`);
        }
      }
    }
  }

  toggle() {
    if (this.enabled || this.scanning) {
      this.stop('Fishing disabled.');
      return;
    }

    if (!this.playerGameId) {
      this.command.message('You must be logged in before toggling auto-fishing.');
      return;
    }

    this.enabled = true;
    this.scanning = true;
    this.triedDismantling = false;
    this.negoWaiting = false;
    this.pendingDeals.length = 0;
    this.mod.clearAllTimeouts();

    this.command.message('Let me Fish is now: enabled.');
    let stepIndex = 1;
    if (!this.craftId) {
      this.command.message(`${stepIndex++}) Click craft on a bait recipe you want to auto-craft`);
    }
    this.command.message(`${stepIndex}) Throw your rod - and it will auto-start`);
  }

  stop(reason, options = {}) {
    const { cancelContract = true, notify = true } = options;
    if (!this.enabled && !this.scanning) {
      if (reason) this.command.message(reason);
      return;
    }

    const wasScanning = this.scanning;
    this.enabled = false;
    this.scanning = false;
    this.negoWaiting = false;
    this.pendingDeals.length = 0;
    this.tooMuchFishes = false;
    this.awaitingDismantling = 0;
    this.itemsInserted = 0;
    this.theFishes = [];
    this.triedDismantling = false;
    this.mod.clearAllTimeouts();

    if (this.vContractId && cancelContract) {
      this.mod.toServer('C_CANCEL_CONTRACT', this.useVersion('C_CANCEL_CONTRACT'), {
        type: this.dismantleContractType,
        id: this.vContractId
      });
      this.vContractId = null;
    } else if (this.vContractId && !cancelContract) {
      this.vContractId = null;
    }

    if (reason) {
      if (!notify || reason === 'Fishing disabled.') {
        this.command.message(reason);
      } else {
        this.notify(reason);
      }
    }

    if (!wasScanning && this.statFished > 0) {
      const duration = this.statStarted ? Date.now() - this.statStarted : 0;
      const perFish = this.statFished ? Math.round((duration / this.statFished) / 1000) : 0;
      this.command.message(`Fished out: ${this.statFished} fishes. Time elapsed: ${formatDuration(duration)}. Per fish: ${perFish} sec`);
      if (Object.keys(this.statFishedTiers).length) {
        Object.entries(this.statFishedTiers).forEach(([tier, count]) => {
          this.command.message(`Tier ${tier}: ${count}`);
        });
      }
      this.statFished = 0;
      this.statFishedTiers = {};
      this.statStarted = null;
    } else if (wasScanning && !reason) {
      this.command.message('You decided not to fish?');
    }
  }

  printStatus() {
    if (!this.enabled && !this.scanning) {
      this.command.message('Auto-fishing is currently disabled.');
      return;
    }

    const elapsed = this.statStarted ? Date.now() - this.statStarted : 0;
    this.command.message(`Auto-fishing is ${this.enabled ? 'enabled' : 'scanning'}; runtime ${formatDuration(elapsed)}; total fish ${this.statFished}`);
    if (Object.keys(this.statFishedTiers).length) {
      this.command.message(`Breakdown: ${sumStats(this.statFishedTiers)}`);
    }
    this.command.message(`Current bait: ${this.baitId || 'none'}, recipe: ${this.craftId || 'none'}, dismantle common: ${this.settings.dismantleFish}, dismantle gold: ${this.settings.dismantleFishGold}`);
  }

  toggleDismantle(isGold) {
    if (isGold) {
      this.settings.dismantleFishGold = !this.settings.dismantleFishGold;
      this.command.message(`Gold Fish dismantling is now: ${this.settings.dismantleFishGold ? 'enabled' : 'disabled'}.`);
    } else {
      this.settings.dismantleFish = !this.settings.dismantleFish;
      this.command.message(`Common Fish dismantling is now: ${this.settings.dismantleFish ? 'enabled' : 'disabled'}.`);
    }
  }

  resetPreferences() {
    this.settings.dismantleFish = true;
    this.settings.dismantleFishGold = false;
    this.craftId = 0;
    this.baitId = 0;
    this.settings.craftId = 0;
    this.settings.baitId = 0;
    this.command.message('Craft recipe reset.');
    this.command.message('Bait type for reuse reset.');
    this.command.message('Types of fishes to auto-dismantle reset.');
  }

  listPreferences() {
    this.command.message(`Recipe for auto-craft: ${this.craftId || 'none'}`);
    this.command.message(`Bait for reusing after craft: ${this.baitId || 'none'}`);
    this.command.message(`Fish auto-dismantling for common fish: ${this.settings.dismantleFish}, for goldfish: ${this.settings.dismantleFishGold}`);
  }

  savePreferences() {
    if (!this.settingsFile) {
      this.command.message('Cannot save settings before login.');
      return;
    }

    this.settings.craftId = this.craftId;
    this.settings.baitId = this.baitId;

    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, '\t'));
      this.command.message('Settings saved and will be carried over to the next session on this character.');
    } catch (err) {
      this.command.message(`Error saving settings ${err.message}`);
    }
  }

  loadPreferences(forceMessage = false) {
    if (!this.settingsFile) {
      if (forceMessage) this.command.message('Cannot load settings before login.');
      return;
    }

    try {
      const raw = fs.readFileSync(this.settingsFile, 'utf8');
      const data = JSON.parse(raw);
      this.settings = Object.assign({ dismantleFish: true, dismantleFishGold: false, craftId: 0, baitId: 0 }, data);
      this.craftId = this.settings.craftId || 0;
      this.baitId = this.settings.baitId || 0;
      if (this.craftId) {
        const found = BAIT_RECIPES.find(it => it.recipeId === this.craftId);
        if (found) {
          this.baitId = found.itemId;
        } else {
          this.notify('Your config file is corrupted, bait recipe id is wrong');
          this.craftId = 0;
        }
      }
      if (forceMessage) this.command.message('reLoaded settings file');
    } catch (err) {
      if (forceMessage) this.command.message('Failed to load settings, using defaults.');
      this.settings = { dismantleFish: true, dismantleFishGold: false, craftId: 0, baitId: 0 };
      this.craftId = 0;
      this.baitId = 0;
    }
  }

  onLogin(event) {
    this.resetState();
    this.playerGameId = event.gameId;
    this.playerName = event.name;
    this.serverId = event.serverId;
    this.settingsFile = resolveDataFile(this.playerName, this.serverId, __dirname);
    this.loadPreferences();
  }

  onFishingStart(event) {
    if (!this.enabled || this.scanning) return;
    if (event.gameId !== this.playerGameId) return;

    const fishTier = event.level;
    if (DELAY_BASED_ON_FISH_TIER) {
      this.currentTier = fishTier;
    }
    this.statFishedTiers[fishTier] = (this.statFishedTiers[fishTier] || 0) + 1;
    this.command.message(`Started fishing minigame, Tier ${fishTier}`);
    this.mod.setTimeout(() => this.catchFish(), rng(ACTION_DELAY_FISH_CATCH) + (this.currentTier * 1000));
    return false;
  }

  onFishingBite(event) {
    if (!this.enabled) return;
    if (event.gameId !== this.playerGameId) return;

    this.mod.clearAllTimeouts();
    this.mod.setTimeout(() => this.reelFish(), rng(ACTION_DELAY_FISH_START));
    this.leftArea = 0;

    if (this.scanning) {
      this.scanning = false;
      this.rodId = event.rodId;
      this.statStarted = Date.now();
      this.command.message(`Rod set to: ${this.rodId}`);
      if (!this.craftId) {
        this.command.message("You didn't provide a bait recipe for auto-craft, let-me-fish will stop once it runs out of bait...");
      }
      if (!this.settings.dismantleFish) {
        this.command.message('You turned OFF fish auto-dismantling for common fish, let-me-fish will stop once inventory runs out of space...');
      }
      this.command.message('Auto-fishing is started now.');
    }
    return false;
  }

  onSystemMessage(event) {
    if (!this.enabled) return;
    const msg = this.mod.parseSystemMessage(event.message);
    if (!msg) return;

    switch (msg.id) {
      case 'SMT_CANNOT_FISHING_NON_BAIT':
        this.command.message('Out of bait, lets craft some!');
        this.mod.clearAllTimeouts();
        this.mod.setTimeout(() => this.craftBaitStart(false), rng(ACTION_DELAY_FISH_START));
        break;
      case 'SMT_ITEM_CANT_POSSESS_MORE':
        this.handleInventoryCap(msg);
        break;
      case 'SMT_CANNOT_FISHING_FULL_INVEN':
        this.command.message('Inventory full, lets dismantle fish!');
        this.mod.clearAllTimeouts();
        this.mod.setTimeout(() => this.cleanupByDismantle(), rng(ACTION_DELAY_FISH_START) + 1500);
        break;
      case 'SMT_CANNOT_FISHING_NON_AREA':
        if (this.negoWaiting) break;
        this.command.message('Fishing area changed (you left it?), well that happens... lets try again?');
        this.mod.clearAllTimeouts();
        this.leftArea++;
        if (this.leftArea < 7) {
          this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD));
        } else {
          this.stop('Fishing area changed for good it seems, cannot fish anymore.');
        }
        break;
      case 'SMT_FISHING_RESULT_CANCLE':
        this.command.message('Fishing cancelled... lets try again?');
        this.mod.clearAllTimeouts();
        this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_FISH_START));
        break;
      case 'SMT_YOU_ARE_BUSY':
        if (this.vContractId) break;
        this.command.message('Evil people trying to disturb your fishing... lets try again?');
        this.mod.clearAllTimeouts();
        this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD) + 3000);
        break;
      case 'SMT_MEDIATE_SUCCESS_SELL':
        if (this.negoWaiting && !this.pendingDeals.length) {
          this.command.message('All negotiations finished... resuming fishing shortly');
          this.mod.clearAllTimeouts();
          this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD) + 5500);
        }
        break;
      case 'SMT_CANNOT_USE_ITEM_WHILE_CONTRACT':
        this.negoWaiting = true;
        this.command.message('Negotiations are taking long time to finish... lets wait a bit more');
        this.mod.clearAllTimeouts();
        this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD) + 3000);
        break;
      default:
        break;
    }
  }

  handleInventoryCap(msg) {
    if (!this.vContractId) {
      this.mod.clearAllTimeouts();
      const itemId = Number(msg.tokens?.ItemName?.substr?.(6));
      if (itemId && itemId >= 206006 && itemId <= 206009) {
        this.command.message('Crafted worms to the fullest, lets fish using those now!');
        this.baitId = itemId;
      } else {
        this.command.message('Crafted to the fullest, lets fish again!');
      }
      this.mod.setTimeout(() => this.useBaitItem(), rng(ACTION_DELAY_FISH_START));
    } else if (this.itemsInserted) {
      this.notify('You have reached the 10k dismantled fish parts limit, stopping');
      this.mod.clearAllTimeouts();
      this.tooMuchFishes = false;
      this.dismantleStart0();
      this.mod.setTimeout(() => {
        this.stop('Fish part limit reached.', { cancelContract: false });
      }, rng(ACTION_DELAY_FISH_START) + 4000);
    } else {
      this.stop('Fish part limit reached, stopping.');
    }
  }

  onItemList(event) {
    if (!this.enabled || event.container === 14) return;

    this.inventoryBuffer = event.first ? deepClone(event.items) : this.inventoryBuffer.concat(deepClone(event.items));
    if (!event.more) {
      if (this.inventoryFirstBatch) {
        this.inventoryFirstBatch = false;
        this.inventoryItems = this.inventoryBuffer;
      } else {
        this.inventoryItems = this.inventoryItems.concat(this.inventoryBuffer);
      }
      this.inventoryBuffer = [];
    }

    if (event.lastInBatch && !event.more) {
      this.inventoryFirstBatch = true;
      if (this.tooMuchFishes && this.itemsInserted === 0) {
        this.mod.clearAllTimeouts();
        this.mod.setTimeout(() => this.cleanupByDismantle(), rng(ACTION_DELAY_FISH_START) / 3);
      }
    }
  }

  onInventory(event) {
    if (!this.enabled || event.first === undefined) return;

    this.inventoryItems = event.first ? deepClone(event.items) : this.inventoryItems.concat(deepClone(event.items));
    if (this.tooMuchFishes && this.itemsInserted === 0 && !event.more) {
      this.mod.clearAllTimeouts();
      this.mod.setTimeout(() => this.cleanupByDismantle(), rng(ACTION_DELAY_FISH_START) / 3);
    }
  }

  onContractRequested(event) {
    if (!this.enabled || this.scanning) return;
    if (event.type !== this.dismantleContractType || event.senderId !== this.playerGameId) return;

    this.vContractId = event.id;
    this.command.message(`Got the contract id for dismantling: ${event.id}`);
    this.mod.clearAllTimeouts();
    this.mod.setTimeout(() => this.dismantlePutInOneFish(), rng(ACTION_DELAY_FISH_START) / 2);
  }

  onContractCancelled(event) {
    if (!this.enabled || this.scanning) return;
    if (event.type !== this.dismantleContractType || event.id !== this.vContractId || event.senderId !== this.playerGameId) return;

    this.vContractId = null;
    this.command.message('Contract for dismantling cancelled (not by let-me-fish), retrying fishing sequence...');
    this.mod.clearAllTimeouts();
    this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD));
  }

  onStartProduce(event) {
    if (!this.scanning) return;
    this.craftId = event.recipe;
    const found = BAIT_RECIPES.find(obj => obj.recipeId === event.recipe);
    if (found) {
      this.baitId = found.itemId;
      this.settings.craftId = event.recipe;
      this.settings.baitId = this.baitId;
      this.command.message(`Now this recipe would get crafted when out of bait: ${event.recipe}, bait will be: ${this.baitId}`);
    } else {
      this.command.message('What did you just craft instead of a bait?! Go craft some bait!');
    }
  }

  onEndProduce(event) {
    if (!this.enabled || this.scanning || !event.success) return;
    this.craftBaitStart(true);
  }

  onBrokerDeal(event) {
    if (!this.enabled || this.scanning || !this.hasNego || this.negoWaiting) return;
    if (event.offeredPrice !== event.sellerPrice) return;

    this.pendingDeals = this.pendingDeals.filter(deal => !(deal.playerId === event.playerId && deal.listing === event.listing));
    this.pendingDeals.push(event);
    this.command.message('Nego deal was suggested, gonna address it after current fish...');
    return false;
  }

  onUseItem(event) {
    if (!this.enabled) return;
    if (event.gameId !== this.playerGameId) return;
    if (event.id === this.rodId) {
      this.playerLoc = { loc: event.loc, w: event.w };
    }
  }

  reelFish() {
    this.mod.toServer('C_START_FISHING_MINIGAME', this.useVersion('C_START_FISHING_MINIGAME'), { counter: 1, unk: 15 });
  }

  catchFish() {
    this.statFished++;
    this.mod.toServer('C_END_FISHING_MINIGAME', this.useVersion('C_END_FISHING_MINIGAME'), {
      counter: 1,
      unk: 24,
      success: true
    });
    this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD) + 500);
  }

  checkIfFishing() {
    this.notify('Why are we not fishing?... Maybe no bait used?');
    this.mod.setTimeout(() => this.useBaitItem(), 500);
  }

  throwRod() {
    if (!this.enabled) return;

    if (this.pendingDeals.length) {
      this.command.message('Lets address suggested deals and give it some time...');
      const dealVersion = this.useVersion('S_TRADE_BROKER_DEAL_SUGGESTED');
      this.pendingDeals.forEach(deal => this.mod.toClient('S_TRADE_BROKER_DEAL_SUGGESTED', dealVersion, deal));
      this.pendingDeals.length = 0;
      this.negoWaiting = true;
      this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD) * 6);
      return;
    }

    if (this.baitId && !this.inventoryItems.some(item => item.id === this.baitId)) {
      this.command.message('No bait found in inventory, lets craft some!');
      this.mod.setTimeout(() => this.craftBaitStart(false), rng(ACTION_DELAY_FISH_START) / 4);
      return;
    }

    if (!this.rodId) {
      this.stop("You didn't use your rod item when you was told to, did you? Now let-me-fish can't rethrow it for you...");
      return;
    }

    this.negoWaiting = false;
    this.mod.toServer('C_USE_ITEM', this.useVersion('C_USE_ITEM'), {
      gameId: this.playerGameId,
      id: this.rodId,
      dbid: 0n,
      target: 0n,
      amount: 1,
      dest: 0,
      loc: this.playerLoc?.loc || { x: 0, y: 0, z: 0 },
      w: this.playerLoc?.w || 0,
      unk1: 0,
      unk2: 0,
      unk3: 0,
      unk4: true
    });
    this.mod.clearAllTimeouts();
    this.mod.setTimeout(() => this.checkIfFishing(), rng(ACTION_DELAY_FISH_START) + 180000);
  }

  useBaitItem() {
    if (!this.baitId) {
      this.stop('How can you fish without a bait?... hmmm...');
      return;
    }

    this.triedDismantling = false;
    this.mod.toServer('C_USE_ITEM', this.useVersion('C_USE_ITEM'), {
      gameId: this.playerGameId,
      id: this.baitId,
      dbid: 0n,
      target: 0n,
      amount: 1,
      dest: 0,
      loc: this.playerLoc?.loc || { x: 0, y: 0, z: 0 },
      w: this.playerLoc?.w || 0,
      unk1: 0,
      unk2: 0,
      unk3: 0,
      unk4: true
    });
    this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_FISH_START));
  }

  cleanupByDismantle() {
    if (!this.enabled) return;
    if (!this.settings.dismantleFish && !this.settings.dismantleFishGold) {
      this.stop('You disabled auto-dismantle, stopping.');
      return;
    }

    const dismantleList = [];
    if (this.settings.dismantleFish) {
      dismantleList.push(...this.inventoryItems.filter(item => item.id >= 206400 && item.id <= 206456));
    }
    if (this.settings.dismantleFishGold) {
      dismantleList.push(...this.inventoryItems.filter(item => item.id >= 206500 && item.id <= 206514));
    }

    if (!dismantleList.length) {
      if (this.awaitingDismantling <= 0) {
        this.stop("No fishes-to-dismantle found in your inventory, can't free up space, stopping");
      } else {
        this.command.message(`There are still ${this.awaitingDismantling} fishes awaiting dismantling but none were found in inventory, ignoring the mismatch and continuing.`);
        this.debugLog('inventory snapshot', this.inventoryItems);
        this.debugLog('pending fish snapshot', this.theFishes);
        this.awaitingDismantling = 0;
        this.mod.setTimeout(() => this.dismantleStart2(), rng(ACTION_DELAY_FISH_START));
      }
      return;
    }

    const totalFish = dismantleList.length;
    if (totalFish > 20) {
      this.command.message(`Found total fishes: ${totalFish}`);
    }
    this.command.message(`Gonna dismantle this much fishes now: ${Math.min(totalFish, 20)}`);
    this.awaitingDismantling = totalFish;
    this.tooMuchFishes = totalFish > 20;
    this.itemsInserted = 0;

    if (this.tooMuchFishes) {
      dismantleList.length = 20;
    }

    this.theFishes = dismantleList;
    if (!this.vContractId) {
      this.mod.toServer('C_REQUEST_CONTRACT', this.useVersion('C_REQUEST_CONTRACT'), { type: this.dismantleContractType });
    }
    this.mod.setTimeout(() => this.dismantlePutInOneFish(), rng(ACTION_DELAY_FISH_START) + 15000);
  }

  dismantlePutInOneFish() {
    if (!this.vContractId) {
      this.command.message('No contract received for dismantling, retrying...');
      this.mod.setTimeout(() => this.cleanupByDismantle(), rng(ACTION_DELAY_FISH_START) + 1500);
      return;
    }

    const fish = this.theFishes?.pop();
    if (fish) {
      this.command.message(`Fish goes into dismantler: id ${fish.id}, ${fish.dbid}`);
      this.itemsInserted++;
      this.mod.toServer('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', this.useVersion('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT'), {
        contractId: this.vContractId,
        dbid: fish.dbid,
        id: fish.id,
        count: 1
      });
      if (this.theFishes.length) {
        this.mod.setTimeout(() => this.dismantlePutInOneFish(), rng(ACTION_DELAY_FISH_START) / 4);
      } else {
        this.mod.setTimeout(() => this.dismantleStart0(), rng(ACTION_DELAY_FISH_START) / 2);
      }
    }
  }

  dismantleStart0() {
    if (!this.vContractId) return;
    this.mod.toServer('C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION', this.useVersion('C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION'), {
      contract: this.vContractId
    });
    this.mod.setTimeout(() => this.dismantleStart(), 1925);
  }

  dismantleStart() {
    this.awaitingDismantling -= this.itemsInserted;
    this.itemsInserted = 0;
    this.mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', this.useVersion('C_RQ_COMMIT_DECOMPOSITION_CONTRACT'), {
      contract: this.vContractId
    });
    if (this.tooMuchFishes) {
      this.mod.setTimeout(() => this.cleanupByDismantle(), rng(ACTION_DELAY_FISH_START) + 5500);
    } else {
      this.mod.setTimeout(() => this.dismantleStart2(), rng(ACTION_DELAY_FISH_START));
    }
  }

  dismantleStart2() {
    if (this.vContractId) {
      this.mod.toServer('C_CANCEL_CONTRACT', this.useVersion('C_CANCEL_CONTRACT'), {
        type: this.dismantleContractType,
        id: this.vContractId
      });
      this.vContractId = null;
    }
    if (this.enabled) {
      this.mod.setTimeout(() => this.throwRod(), rng(ACTION_DELAY_THROW_ROD) + 1000);
    }
  }

  craftBaitStart(chain) {
    if (!this.craftId) {
      this.stop("You didn't provide a sample craft recipe, did you? Now let-me-fish can't craft more bait for you...");
      return;
    }

    const filetItem = this.inventoryItems.find(item => item.id === 204052);
    const needed = (chain ? 2 : 1) * (15 + ((this.craftId - 204100) * 5));

    if (filetItem && filetItem.amount >= needed) {
      this.mod.toServer('C_START_PRODUCE', this.useVersion('C_START_PRODUCE'), { recipe: this.craftId, unk: 0 });
      const recipe = BAIT_RECIPES.find(obj => obj.recipeId === this.craftId);
      if (recipe) this.baitId = recipe.itemId;
    } else if (!this.triedDismantling) {
      this.triedDismantling = true;
      this.mod.setTimeout(() => this.cleanupByDismantle(), rng(ACTION_DELAY_THROW_ROD));
      this.command.message("You don't have enough fish parts to craft a bait... dismantling fishes to get some");
    } else if (chain || this.inventoryItems.some(item => item.id === this.baitId)) {
      this.command.message('Crafted few bait items, then ran out of fish parts, but lets fish again anyway with what we have now!');
      this.mod.setTimeout(() => this.useBaitItem(), rng(ACTION_DELAY_FISH_START));
    } else {
      this.stop("You don't have enough fish parts to craft a bait and no fish to dismantle for fish parts... stopping");
    }
  }

  useVersion(packet, fallback = 1) {
    if (this.activeVersions[packet]) {
      return this.activeVersions[packet];
    }
    const versions = PACKET_VERSIONS[packet];
    if (!versions || !versions.length) return fallback;
    const versionList = Array.isArray(versions) ? versions : [versions];
    const resolved = versionList[0];
    this.activeVersions[packet] = resolved;
    return resolved;
  }

  notify(message, timeout) {
    this.command.message(message);
    if (this.notifier) {
      try {
        this.notifier.notifyafk({
          title: 'Fishing',
          message,
          wait: false,
          sound: 'Notification.IM'
        }, timeout);
      } catch (err) {
        this.mod.error('[auto-fishing] notifier error', err);
      }
    }
  }

  debugLog(...args) {
    if (typeof this.mod.log === 'function') {
      this.mod.log('[auto-fishing]', ...args);
    } else {
      console.log('[auto-fishing]', ...args);
    }
  }
}
