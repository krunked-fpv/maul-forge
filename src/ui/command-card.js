import {
  FUSION_TOWER_IDS,
  INITIAL_RUN_CONFIG,
} from '../contracts/types.js';
import {
  BASE_TOWERS,
  FUSION_TOWERS,
  CHAOS_APEX_UPGRADE,
  getTowerStats,
  getAvailableFusionsForTower,
} from '../engine/towers-data.js';

export const COMMAND_SLOT_KEYS = Object.freeze([
  'Q', 'W', 'E', 'R',
  'A', 'S', 'D', 'F',
  'Z', 'X', 'C', 'V',
]);

const FUSION_SLOT_INDICES = Object.freeze([1, 2, 3, 6, 8]); // W, E, R, D, Z

const LINEAGE_SHORT = Object.freeze({
  ballista: 'Ballista',
  mortar: 'Mortar',
  frost: 'Frost',
  tesla: 'Tesla',
  venom: 'Venom',
  brazier: 'Brazier',
});

const BUILD_DESC = Object.freeze({
  ballista: 'Pierce bolts · Fast fire, bonus Air damage at T4 [Q / 1]',
  mortar: 'Siege splash · Triggers 3.0× Shatter vs Deep Freeze [W / 2]',
  frost: 'Elemental chill & Deep Freeze prism (T3+) [E / 3]',
  tesla: 'Magic chain lightning · Micro-stun at T3+ [R / 4]',
  venom: 'Elemental Acid Sundering (−2.5 armor/stack) + DoT [F / 5 / T]',
  brazier: 'Elemental Ignite burn DoT + splash (T2+) [V / 6 / Y]',
});

function getLineageFusions(lineageId) {
  const out = [];
  for (let i = 0; i < FUSION_TOWER_IDS.length; i++) {
    const fusionId = FUSION_TOWER_IDS[i];
    const def = FUSION_TOWERS[fusionId];
    const [a, b] = def.recipe;
    if (a !== lineageId && b !== lineageId) continue;
    out.push({
      fusionId,
      name: def.name,
      partnerLineage: a === lineageId ? b : a,
      cost: def.cost,
      attackType: def.attackType,
    });
  }
  return out;
}

/**
 * Renders and manages the strict 4x3 WC3 Hotkey Command Card (Q W E R / A S D F / Z X C V)
 * using zero innerHTML churn so hover/click state remains rock-solid at 60Hz.
 */
export class CommandCardController {
  constructor(options = {}) {
    this.gridEl = options.gridEl || document.getElementById('command-grid');
    this.ttNameEl = options.ttNameEl || document.getElementById('tt-name');
    this.ttDescEl = options.ttDescEl || document.getElementById('tt-desc');

    this.callbacks = {
      onSelectBuild: options.onSelectBuild || (() => {}),
      onUpgradeTower: options.onUpgradeTower || (() => {}),
      onFuseTower: options.onFuseTower || (() => {}),
      onSellTower: options.onSellTower || (() => {}),
      onCyclePriority: options.onCyclePriority || (() => {}),
      onToggleForceRetarget: options.onToggleForceRetarget || (() => {}),
      onToggleBuilderMode: options.onToggleBuilderMode || (() => {}),
      onSendWave: options.onSendWave || (() => {}),
      onCycleSpeed: options.onCycleSpeed || (() => {}),
      onShareCartridge: options.onShareCartridge || (() => {}),
      onOpenBlueprint: options.onOpenBlueprint || (() => {}),
      onToggleMute: options.onToggleMute || (() => {}),
      onFocusCreep: options.onFocusCreep || (() => {}),
      onClearSelection: options.onClearSelection || (() => {}),
      onOpenMatrix: options.onOpenMatrix || (() => {}),
    };

    this.essenceInfuseArmed = false;
    this._lastTowerId = null;
    this._hoveredSlot = -1;

    this._slotButtons = [];
    this._slotHandlers = new Array(12);
    this._slotSpecs = new Array(12);
    this._renderCache = new Array(12).fill(null);

    this._buildDom();
  }

  _buildDom() {
    if (!this.gridEl) return;
    this.gridEl.innerHTML = '';

    for (let i = 0; i < 12; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmd-btn is-empty';
      btn.dataset.slot = String(i);
      btn.setAttribute('role', 'gridcell');

      const top = document.createElement('div');
      top.className = 'cmd-top';

      const hotkey = document.createElement('span');
      hotkey.className = 'cmd-hotkey';
      hotkey.textContent = COMMAND_SLOT_KEYS[i];

      const cost = document.createElement('span');
      cost.className = 'cmd-cost';

      top.appendChild(hotkey);
      top.appendChild(cost);

      const title = document.createElement('div');
      title.className = 'cmd-title';

      const sub = document.createElement('div');
      sub.className = 'cmd-sub';

      btn.appendChild(top);
      btn.appendChild(title);
      btn.appendChild(sub);

      btn.addEventListener('click', () => {
        this.triggerSlot(i);
      });
      btn.addEventListener('pointerenter', () => {
        this._hoveredSlot = i;
        this._syncTooltip();
      });
      btn.addEventListener('pointerleave', () => {
        if (this._hoveredSlot === i) {
          this._hoveredSlot = -1;
          this._syncTooltip();
        }
      });

      this.gridEl.appendChild(btn);
      this._slotButtons.push({ btn, hotkey, cost, title, sub });
    }
  }

  resetTransientState() {
    this.essenceInfuseArmed = false;
  }

  triggerSlot(slotIndex) {
    const spec = this._slotSpecs[slotIndex];
    const handler = this._slotHandlers[slotIndex];
    if (!spec || spec.disabled || typeof handler !== 'function') {
      return false;
    }
    handler();
    return true;
  }

  triggerHotkey(keyChar) {
    const upper = String(keyChar || '').toUpperCase();
    const idx = COMMAND_SLOT_KEYS.indexOf(upper);
    if (idx === -1) return false;
    return this.triggerSlot(idx);
  }

  _syncTooltip() {
    if (!this.ttNameEl || !this.ttDescEl) return;
    if (this._hoveredSlot >= 0 && this._slotSpecs[this._hoveredSlot]) {
      const spec = this._slotSpecs[this._hoveredSlot];
      if (!spec.empty) {
        if (this.ttNameEl.textContent !== spec.title) {
          this.ttNameEl.textContent = spec.title;
        }
        const desc = spec.tooltip || spec.sub || '';
        if (this.ttDescEl.textContent !== desc) {
          this.ttDescEl.textContent = desc;
        }
        return;
      }
    }
    if (this.ttNameEl.textContent !== 'Command Deck') {
      this.ttNameEl.textContent = 'Command Deck';
    }
    const defaultDesc = 'Hotkeys Q W E R / A S D F / Z X C V · 1–6 & T/Y Build';
    if (this.ttDescEl.textContent !== defaultDesc) {
      this.ttDescEl.textContent = defaultDesc;
    }
  }

  _applySlot(idx, spec, handler) {
    this._slotSpecs[idx] = spec;
    this._slotHandlers[idx] = handler;

    const nodes = this._slotButtons[idx];
    if (!nodes) return;

    const classes = ['cmd-btn'];
    if (spec.empty) classes.push('is-empty');
    if (spec.armed) classes.push('is-armed');
    if (spec.readyNeighbor) classes.push('is-ready-neighbor');
    if (spec.readyEssence) classes.push('is-ready-essence');
    if (spec.essenceArmed) classes.push('is-essence-armed');
    if (spec.danger) classes.push('is-danger');
    if (spec.unaffordable) classes.push('is-unaffordable');
    const classStr = classes.join(' ');

    const fp = `${classStr}|${spec.disabled ? 1 : 0}|${spec.title}|${spec.cost}|${spec.sub}`;
    if (this._renderCache[idx] === fp) return;
    this._renderCache[idx] = fp;

    nodes.btn.className = classStr;
    nodes.btn.disabled = Boolean(spec.disabled);
    nodes.cost.textContent = spec.cost || '';
    nodes.title.textContent = spec.title || '';
    nodes.sub.textContent = spec.sub || '';
  }

  update(sim, state) {
    const selectedTower = state.selectedTowerId ? sim.getTowerById(state.selectedTowerId) : null;
    const selectedCreep = !selectedTower && state.selectedCreepId ? sim.getCreepById(state.selectedCreepId) : null;

    const curTowerId = selectedTower ? selectedTower.id : null;
    if (curTowerId !== this._lastTowerId) {
      this._lastTowerId = curTowerId;
      this.essenceInfuseArmed = false;
    }

    if (selectedTower) {
      this._renderTowerSelected(sim, state, selectedTower);
    } else if (selectedCreep && selectedCreep.active) {
      this._renderCreepSelected(sim, state, selectedCreep);
    } else {
      this._renderIdleBuild(sim, state);
    }

    this._syncTooltip();
  }

  _makeBuildSlot(sim, state, lineageId, subHint) {
    const t1 = BASE_TOWERS[lineageId].tiers[0];
    const canAfford = sim.gold >= t1.cost;
    const armed = state.activeBuildLineage === lineageId;
    return {
      spec: {
        empty: false,
        disabled: sim.phase === 'gameover',
        armed,
        unaffordable: !canAfford,
        title: LINEAGE_SHORT[lineageId] || t1.name,
        cost: `${t1.cost}g`,
        sub: subHint,
        tooltip: `${t1.name} (${t1.cost}g) — ${BUILD_DESC[lineageId] || ''}`,
      },
      handler: () => this.callbacks.onSelectBuild(lineageId),
    };
  }

  _makeSendWaveSlot(sim) {
    const spawning = sim.phase === 'combat' && sim._spawnCursor < sim._spawnQueue.length;
    const earlyBonus =
      sim.phase === 'prep' && sim.prepTimer > 0
        ? Math.round(sim.prepTimer * INITIAL_RUN_CONFIG.earlySendBonusPerSec)
        : 0;
    const disabled = sim.phase === 'gameover' || spawning;
    return {
      spec: {
        empty: false,
        disabled,
        armed: sim.phase === 'prep' && !disabled,
        title: spawning ? 'Spawning…' : 'Send Wave',
        cost: earlyBonus > 0 ? `+${earlyBonus}g` : `W${sim.wave + 1}`,
        sub: spawning ? 'Wave Active' : (earlyBonus > 0 ? 'Early Bonus' : 'Next Wave'),
        tooltip:
          spawning
            ? 'Wave currently spawning from North & South Rifts'
            : `Launch Wave ${sim.wave + 1}${earlyBonus > 0 ? ` immediately (+${earlyBonus}g bonus)` : ''} [Space]`,
      },
      handler: () => this.callbacks.onSendWave(),
    };
  }

  _makeMuteSlot(state) {
    const muted = Boolean(state.isMuted);
    return {
      spec: {
        empty: false,
        disabled: false,
        armed: muted,
        title: muted ? 'Unmute' : 'Mute Audio',
        cost: muted ? 'OFF' : 'ON',
        sub: 'Web Audio',
        tooltip: 'Toggle procedural Web Audio DSP mute [C / M]',
      },
      handler: () => this.callbacks.onToggleMute(),
    };
  }

  _makeSpeedSlot(sim) {
    return {
      spec: {
        empty: false,
        disabled: false,
        armed: sim.gameSpeed > 1,
        title: 'Game Speed',
        cost: `${sim.gameSpeed}×`,
        sub: 'Cycle 1–3×',
        tooltip: `Cycle simulation speed (${sim.gameSpeed}× -> ${(sim.gameSpeed % 3) + 1}×)`,
      },
      handler: () => this.callbacks.onCycleSpeed(),
    };
  }

  _makeBuilderModeSlot(sim) {
    const isInstant = sim.builderMode === 'instant';
    return {
      spec: {
        empty: false,
        disabled: false,
        armed: !isInstant,
        title: isInstant ? 'Instant Forge' : 'Spirit Builder',
        cost: isInstant ? 'INST' : 'SPIRIT',
        sub: 'Toggle Mode',
        tooltip: isInstant
          ? 'Instant Forge: towers activate immediately. Click to switch to Spirit Architect.'
          : 'Spirit Architect: hovering spirit forges towers. Click to switch to Instant Forge.',
      },
      handler: () => this.callbacks.onToggleBuilderMode(),
    };
  }

  _renderIdleBuild(sim, state) {
    const q = this._makeBuildSlot(sim, state, 'ballista', 'Pierce [1]');
    const w = this._makeBuildSlot(sim, state, 'mortar', 'Siege [2]');
    const e = this._makeBuildSlot(sim, state, 'frost', 'Chill [3]');
    const r = this._makeBuildSlot(sim, state, 'tesla', 'Chain [4]');
    const a = this._makeBuilderModeSlot(sim);
    const s = this._makeSendWaveSlot(sim);
    const d = this._makeSpeedSlot(sim);
    const f = this._makeBuildSlot(sim, state, 'venom', 'Acid [5/T]');
    const z = {
      spec: {
        empty: false,
        disabled: false,
        title: 'Share #maze=',
        cost: 'LINK',
        sub: 'Copy URL',
        tooltip: 'Generate & copy subpath-safe #maze= cartridge URL hash [Z]',
      },
      handler: () => this.callbacks.onShareCartridge(),
    };
    const x = {
      spec: {
        empty: false,
        disabled: false,
        title: 'Blueprint',
        cost: 'JSON',
        sub: 'Vault Modal',
        tooltip: 'Open Blueprint JSON Export / Import & Cartridge Vault Modal [X]',
      },
      handler: () => this.callbacks.onOpenBlueprint(),
    };
    const c = this._makeMuteSlot(state);
    const v = this._makeBuildSlot(sim, state, 'brazier', 'Ignite [6/Y]');

    const all = [q, w, e, r, a, s, d, f, z, x, c, v];
    for (let i = 0; i < 12; i++) {
      this._applySlot(i, all[i].spec, all[i].handler);
    }
  }

  _renderTowerSelected(sim, state, tower) {
    const slots = new Array(12);
    for (let i = 0; i < 12; i++) {
      slots[i] = {
        spec: { empty: true, disabled: true, title: '', cost: '', sub: '', tooltip: '' },
        handler: null,
      };
    }

    // [Q] Upgrade Tier OR Chaos Apex Ascension
    if (!tower.fusionId && tower.tier < 4) {
      const nextStats = getTowerStats(tower.lineageId, tower.tier + 1);
      const canAfford = sim.gold >= nextStats.cost;
      slots[0] = {
        spec: {
          empty: false,
          disabled: sim.phase === 'gameover',
          unaffordable: !canAfford,
          title: `Upgrade T${tower.tier + 1}`,
          cost: `${nextStats.cost}g`,
          sub: nextStats.name,
          tooltip: `Upgrade to ${nextStats.name} (${nextStats.cost}g · Dmg ${nextStats.dmg}, Rng ${nextStats.range})`,
        },
        handler: () => this.callbacks.onUpgradeTower(tower.id),
      };
    } else if (!tower.isChaosApex) {
      const canAfford = sim.gold >= CHAOS_APEX_UPGRADE.cost;
      slots[0] = {
        spec: {
          empty: false,
          disabled: sim.phase === 'gameover',
          unaffordable: !canAfford,
          readyEssence: canAfford,
          title: 'Chaos Apex',
          cost: `${CHAOS_APEX_UPGRADE.cost}g`,
          sub: '1.0× All Armor',
          tooltip: `Ascend to Chaos Apex (${CHAOS_APEX_UPGRADE.cost}g · ×1.45 Dmg, +0.6 Rng, 1.00× vs all armor)`,
        },
        handler: () => this.callbacks.onUpgradeTower(tower.id),
      };
    } else {
      slots[0] = {
        spec: {
          empty: false,
          disabled: true,
          armed: true,
          title: 'Apex Maxed',
          cost: 'MAX',
          sub: 'Chaos Aura',
          tooltip: 'Tower has reached Chaos Apex Ascension',
        },
        handler: null,
      };
    }

    // [W/E/R] (+ [D]/[Z] if >3 recipes) Hybrid Elemental Fusions
    const adjLineages = sim.getAdjacentLineages(tower);
    const available = getAvailableFusionsForTower(tower, adjLineages, sim.essence);
    const availMap = new Map(available.map((item) => [item.fusionId, item]));
    const recipes = tower.fusionId ? [] : getLineageFusions(tower.lineageId);

    for (let i = 0; i < recipes.length && i < FUSION_SLOT_INDICES.length; i++) {
      const slotIdx = FUSION_SLOT_INDICES[i];
      const rec = recipes[i];
      const avail = availMap.get(rec.fusionId);
      const partnerName = LINEAGE_SHORT[rec.partnerLineage] || rec.partnerLineage;

      if (tower.tier < 3) {
        slots[slotIdx] = {
          spec: {
            empty: false,
            disabled: true,
            title: rec.name,
            cost: `${rec.cost}g`,
            sub: `Req T3 + ${partnerName}`,
            tooltip: `${rec.name} (${rec.attackType}) — Requires Tier 3+ and adjacent ${partnerName} or 1 Essence`,
          },
          handler: null,
        };
      } else {
        const hasNeighbor = Boolean(avail?.canFuseByNeighbor);
        const hasEssence = sim.essence > 0;
        const ready = hasNeighbor || hasEssence;
        const canAfford = sim.gold >= rec.cost;
        const useEssence = !hasNeighbor && hasEssence;
        const subText = hasNeighbor
          ? `Catalyst: ${partnerName}`
          : (hasEssence ? `Use 1 Essence` : `Need ${partnerName}`);

        slots[slotIdx] = {
          spec: {
            empty: false,
            disabled: sim.phase === 'gameover' || !ready,
            unaffordable: ready && !canAfford,
            readyNeighbor: hasNeighbor,
            readyEssence: !hasNeighbor && hasEssence,
            essenceArmed: !hasNeighbor && hasEssence && this.essenceInfuseArmed,
            title: rec.name,
            cost: useEssence ? `${rec.cost}g+✦` : `${rec.cost}g`,
            sub: subText,
            tooltip: `${rec.name} (${rec.attackType}, ${rec.cost}g) — ${subText}`,
          },
          handler: () => this.callbacks.onFuseTower(tower.id, rec.fusionId, useEssence),
        };
      }
    }

    // [A] Cycle Target Priority
    slots[4] = {
      spec: {
        empty: false,
        disabled: false,
        title: 'Priority',
        cost: tower.priority,
        sub: 'Cycle Mode',
        tooltip: `Cycle tower targeting priority (Current: ${tower.priority}) [A]`,
      },
      handler: () => this.callbacks.onCyclePriority(tower.id),
    };

    // [S] Force Retarget / Rally Builder
    const retargetArmed = Boolean(state.forceRetargetArmed);
    slots[5] = {
      spec: {
        empty: false,
        disabled: false,
        armed: retargetArmed || tower.forcedCreepId > 0,
        title: retargetArmed ? 'Click Creep…' : 'Retarget',
        cost: tower.forcedCreepId > 0 ? `#${tower.forcedCreepId}` : 'AIM',
        sub: sim.builderMode === 'spirit' ? 'Focus / Rally' : 'Force Target',
        tooltip: 'Click a creep to force-target, or right-click terrain to rally Spirit Architect [S]',
      },
      handler: () => this.callbacks.onToggleForceRetarget(tower.id),
    };

    // [D] Speed when not occupied by 4th fusion recipe (i.e. <= 3 recipes or already fused)
    if (recipes.length <= 3) {
      slots[6] = this._makeSpeedSlot(sim);
    }

    // [F] Infuse Essence toggle/fusion
    if (tower.fusionId) {
      slots[7] = {
        spec: {
          empty: false,
          disabled: true,
          title: 'Fused',
          cost: `✦${sim.essence}`,
          sub: 'Hybrid Ready',
          tooltip: 'Tower is already a Hybrid Elemental Fusion',
        },
        handler: null,
      };
    } else {
      const canInfuse = tower.tier >= 3 && sim.essence > 0;
      slots[7] = {
        spec: {
          empty: false,
          disabled: !canInfuse,
          armed: this.essenceInfuseArmed && canInfuse,
          readyEssence: canInfuse,
          title: this.essenceInfuseArmed ? 'Essence ON' : 'Infuse Ess',
          cost: `✦${sim.essence}`,
          sub: tower.tier < 3 ? 'Req T3+' : (sim.essence > 0 ? 'Toggle/Fuse' : '0 Essence'),
          tooltip: 'Infuse Fusion Essence: highlights Essence-eligible fusions when no adjacent catalyst is nearby [F]',
        },
        handler: () => {
          this.essenceInfuseArmed = !this.essenceInfuseArmed;
        },
      };
    }

    // [Z] Deselect / Back when not occupied by 5th fusion recipe (i.e. <= 4 recipes or fused)
    if (recipes.length <= 4) {
      slots[8] = {
        spec: {
          empty: false,
          disabled: false,
          title: 'Deselect',
          cost: 'ESC',
          sub: 'Build Menu',
          tooltip: 'Clear selection and return to Build Menu [Esc]',
        },
        handler: () => this.callbacks.onClearSelection(),
      };
    }

    // [X] Send Wave Early
    slots[9] = this._makeSendWaveSlot(sim);

    // [C] Mute Audio
    slots[10] = this._makeMuteSlot(state);

    // [V] Sell Tower (100% prep / 75% combat)
    const rate =
      sim.phase === 'prep'
        ? INITIAL_RUN_CONFIG.graceRefundRate
        : INITIAL_RUN_CONFIG.combatRefundRate;
    const refund = Math.round(tower.goldInvested * rate);
    const ratePct = Math.round(rate * 100);
    slots[11] = {
      spec: {
        empty: false,
        disabled: sim.phase === 'gameover',
        danger: true,
        title: 'Sell Tower',
        cost: `+${refund}g`,
        sub: `${ratePct}% Refund`,
        tooltip: `Salvage tower for +${refund}g (${ratePct}% refund during ${sim.phase} phase) [V]`,
      },
      handler: () => this.callbacks.onSellTower(tower.id),
    };

    for (let i = 0; i < 12; i++) {
      this._applySlot(i, slots[i].spec, slots[i].handler);
    }
  }

  _renderCreepSelected(sim, state, creep) {
    const slots = new Array(12);
    for (let i = 0; i < 12; i++) {
      slots[i] = {
        spec: { empty: true, disabled: true, title: '', cost: '', sub: '', tooltip: '' },
        handler: null,
      };
    }

    // [Q] Open 5x6 Multiplier Matrix
    slots[0] = {
      spec: {
        empty: false,
        disabled: false,
        title: '5×6 Matrix',
        cost: creep.armorType,
        sub: 'Resistances',
        tooltip: `Open 5×6 Attack vs Armor Multiplier Matrix (Inspecting ${creep.armorType})`,
      },
      handler: () => this.callbacks.onOpenMatrix(),
    };

    // [A] Builder Mode
    slots[4] = this._makeBuilderModeSlot(sim);

    // [S] Focus Selected Creep
    slots[5] = {
      spec: {
        empty: false,
        disabled: sim.towers.length === 0,
        armed: true,
        title: 'Focus Creep',
        cost: `#${creep.id}`,
        sub: 'All Towers',
        tooltip: `Command all towers in range to prioritize Creep #${creep.id} [S]`,
      },
      handler: () => this.callbacks.onFocusCreep(creep.id),
    };

    // [D] Speed
    slots[6] = this._makeSpeedSlot(sim);

    // [X] Send Wave
    slots[9] = this._makeSendWaveSlot(sim);

    // [C] Mute Audio
    slots[10] = this._makeMuteSlot(state);

    // [V] Clear Selection
    slots[11] = {
      spec: {
        empty: false,
        disabled: false,
        title: 'Clear Target',
        cost: 'ESC',
        sub: 'Deselect',
        tooltip: 'Clear creep selection [Esc]',
      },
      handler: () => this.callbacks.onClearSelection(),
    };

    for (let i = 0; i < 12; i++) {
      this._applySlot(i, slots[i].spec, slots[i].handler);
    }
  }
}
