#!/usr/bin/env bash
cd /d/Documents/Obsidian-Vault || exit 1
obsidian vault="Obsidian-Vault" eval code="app.plugins.getPlugin('lan-sync').runSync(); 'ok'"
sleep 2
obsidian vault="Obsidian-Vault" eval code="(()=>{const bs=[...document.querySelectorAll('.lan-sync-modal-buttons button')];const b=bs.find(x=>x.textContent&&x.textContent.indexOf('开始同步')>=0);if(b){b.click();return 'clicked';}return 'none';})()"
for i in $(seq 1 40); do sleep 2; a=$(obsidian vault="Obsidian-Vault" eval code="app.plugins.getPlugin('lan-sync').applying" 2>&1 | sed 's/^=> //' | tail -1); if [ "$a" = "false" ] && [ "$i" -gt 2 ]; then break; fi; done
obsidian vault="Obsidian-Vault" eval code="JSON.stringify(app.plugins.getPlugin('lan-sync').logs.slice(-3))"
