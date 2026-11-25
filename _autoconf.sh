#!/usr/bin/env bash
set -u
V=/d/Documents/Obsidian-Vault; cd "$V" || exit 1
D="$V/.obsidian/plugins/lan-sync/data.desktop.json"
U=$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).webdavUser)' "$D")
PW=$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).webdavPassword)' "$D")
BASE="http://192.168.1.12:8080/Obsidian-Vault"; F=_ls_auto.md
run(){ obsidian vault="Obsidian-Vault" eval code="$1" 2>&1 | sed 's/^=> //' | tail -1; }
wsp(){ for i in $(seq 1 40); do sleep 1; s=$(run "(()=>{const p=app.plugins.getPlugin('lan-sync');return JSON.stringify({r:p.syncRunning,a:p.applying});})()"); echo "$s" | grep -q '"r":false,"a":false' && return 0; done; return 1; }
run "(async()=>{const p=app.plugins.getPlugin('lan-sync');p.settings.syncEnabled=false;p.settings.syncDebounceSeconds=0;p.settings.autoConflictResolve=true;p.pendingAutoSync=false;await p.saveSettings();return 'off';})()"
run "(async()=>{await app.vault.adapter.write('$F','AAA-auto');return 'w1';})()"; sleep 1
run "app.plugins.getPlugin('lan-sync').runSync(); 'ok'"; wsp
run "(async()=>{await app.vault.adapter.write('$F','LOCAL-2');return 'w2';})()"
curl -s -m 8 -o /dev/null -w "remote PUT %{http_code}\n" -u "$U:$PW" -X PUT -H "X-OC-Mtime: $(( $(date +%s) + 7 ))" --data-binary 'REMOTE-2' "$BASE/$F"
sleep 1
echo "--- auto runSync(true) ---"
run "app.plugins.getPlugin('lan-sync').runSync(true); 'ok'"; sleep 2
echo "弹出预览弹窗? $(run "!!document.querySelector('.lan-sync-stats')")"
echo "previewOpen: $(run "app.plugins.getPlugin('lan-sync').previewOpen")"
echo "--- 再次 auto 触发（不叠加） ---"
run "app.plugins.getPlugin('lan-sync').runSync(true); 'ok'"; sleep 1
echo "弹窗数量: $(run "document.querySelectorAll('.lan-sync-stats').length")"
run "(()=>{const b=[...document.querySelectorAll('.lan-sync-modal-buttons button')].find(x=>x.textContent&&x.textContent.includes('取消'));if(b)b.click();return 'cancel';})()"; sleep 1
echo "previewOpen(取消后): $(run "app.plugins.getPlugin('lan-sync').previewOpen")"
run "(async()=>{try{await app.vault.adapter.remove('$F');}catch(e){}const p=app.plugins.getPlugin('lan-sync');p.settings.syncEnabled=true;p.settings.syncDebounceSeconds=5;p.settings.autoConflictResolve=true;await p.saveSettings();return 'restored';})()"
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));for(const k of Object.keys(j.entries||{})){if(/_ls_auto/.test(k))delete j.entries[k];}j.updatedAt=Date.now();fs.writeFileSync(p,JSON.stringify(j));console.log("baseline cleaned")' "$V/.obsidian/plugins/lan-sync/baseline.json"
for t in 1 2 3; do c=$(curl -s -m 8 -o /dev/null -w "%{http_code}" -u "$U:$PW" -X DELETE "$BASE/$F"); echo "remote DELETE $c"; [ "$c" = "204" -o "$c" = "404" ] && break; sleep 1; done
echo done
