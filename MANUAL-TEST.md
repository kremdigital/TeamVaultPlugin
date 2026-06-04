# Manual test plan

Чек-лист сценариев, которые `pnpm test` не покрывает (Yjs round-trip
между двумя реальными Obsidian'ами, конфликт-модалки на живом сервере,
длительный оффлайн со свежими правками). Делать против развёрнутого
сервера (`https://31.128.42.55` или другого URL).

## Pre-flight

### 1. Build the plugin into the test vault

```bash
cd D:/DEV/Claude/ObsidianTeams/obsidian-plugin
pnpm install
TEST_VAULT="D:/DEV/Claude/ObsidianTeams/test-vault" pnpm build:vault
```

Получишь:

```
test-vault/.obsidian/plugins/team-vault/
  main.js
  manifest.json
  .hotreload
```

### 2. Native dependencies

`better-sqlite3` и `chokidar` — нативные модули, esbuild оставил их
external. Чтобы Obsidian мог `require()` их, нужно подсунуть
`node_modules` рядом с `main.js`. На Windows проще всего сделать
junction (без admin):

```cmd
cd /d D:\DEV\Claude\ObsidianTeams\test-vault\.obsidian\plugins\team-vault
mklink /J node_modules D:\DEV\Claude\ObsidianTeams\obsidian-plugin\node_modules
```

На Linux/macOS:

```bash
cd D:/DEV/Claude/ObsidianTeams/test-vault/.obsidian/plugins/team-vault
ln -s D:/DEV/Claude/ObsidianTeams/obsidian-plugin/node_modules node_modules
```

> ⚠️ **Electron ABI mismatch.** `better-sqlite3` сборка для Node 20 не
> совпадает с Electron внутри Obsidian. Если при загрузке плагина
> увидишь `Module did not self-register` или `NODE_MODULE_VERSION`
> mismatch — нужен `pnpm rebuild --recursive` против Electron headers.
> Для test-vault'а проще:
>
> ```bash
> cd D:/DEV/Claude/ObsidianTeams/obsidian-plugin
> pnpm dlx @electron/rebuild -m node_modules/better-sqlite3 -v <electron-version>
> ```
>
> Версия Electron'а Obsidian'а — Help → About → "Electron".

### 3. Server side

- API-ключ — из Settings → API Keys на сервере. Скопировать `osk_…`.
- Создать пустой проект (через web-UI).
- Запомнить project id (есть в URL).

### 4. Open Obsidian

Открыть test-vault в Obsidian. Включить **Settings → Community plugins
→ Team Vault**.

## Scenarios

### S1 — First binding, push to empty project

1. Положить в `test-vault` пару `.md` файлов (`note.md`, `subdir/x.md`).
2. Settings → Team Vault → Add server → ввести URL + API-ключ →
   **Test** → ожидать «Подключено как <email>».
3. Add binding → выбрать сервер + проект + `/` (root) → **Bind**.
4. Status bar должен пройти `connecting → syncing → connected`.
5. На сервере (web UI) проверить, что файлы появились с правильным
   путём + содержимым.

### S2 — Pull empty vault from project with content

1. На сервере залить пару файлов через web-UI или `pnpm cli push`.
2. Открыть **второй** vault (`test-vault-2`), включить плагин.
3. Add server + add binding к тому же проекту, локальная папка пустая.
4. После `connected` файлы должны появиться в vault'е автоматически.

### S3 — Live two-device editing (text)

1. Открыть один и тот же `.md` файл в двух Obsidian'ах (S1 + S2 vault).
2. Печатать одновременно в разные места файла.
3. Yjs должен слиять изменения за <2 сек round-trip; обе стороны видят
   финальный текст.
4. Проверить что нет конфликт-модалок (текст идёт через CRDT).

> **Known limitation (MVP):** плагин ловит изменения через
> `vault.on('modify')`, а не через editor-binding (`yCollab`). Это
> значит **Ctrl+Z**, который не пишет в vault file (Obsidian
> откатывает только editor buffer, если буфер совпадает с saved
> state), **не синхронизируется** на другое устройство до
> следующей правки / autosave. Полноценная посимвольная
> collab через `yCollab` (Stage 5.2 готов, нужна интеграция в
> plugin top-level) — отдельная фича, на следующую итерацию.

### S4 — Offline edit → reconnect drain

1. Подключение работает. Сделать небольшое изменение в файле, дождаться
   синка (`connected` → `connected`).
2. Отключить интернет (Wi-Fi off или закрыть socket в DevTools).
3. Status bar → `offline`.
4. Сделать 5–10 правок (modify, delete, rename) — операции должны
   копиться в `pending_operations` (можно посмотреть в SQLite-инспекторе
   или оставить как black-box).
5. Включить интернет.
6. Status bar → `connecting → syncing → connected`. На сервере все
   операции применились.

### S5 — External agent edit (вне Obsidian)

1. Со включённым плагином и активным синком: в терминале:
   ```bash
   echo "external addition" >> "D:/DEV/Claude/ObsidianTeams/test-vault/note.md"
   ```
2. Chokidar должен поймать modify (с дебаунсом 1s).
3. На сервере (или в S2 vault) изменения должны появиться.
4. Дополнительно: создать новый файл через CLI:
   ```bash
   echo "fresh" > "D:/DEV/Claude/ObsidianTeams/test-vault/from-shell.md"
   ```

### S6 — Binary conflict modal

1. В оба vault'а залить одинаковый PNG (через S1 push).
2. На S1: отключиться (тот же приём, что в S4) и заменить PNG другим
   контентом (через шелл `cp other.png …/image.png`). Дождаться
   `pending_operations` (или offline status).
3. Параллельно на S2: заменить тот же PNG третьим вариантом.
4. На S1 включить интернет. Сервер пушит PNG версии S2 → плагин
   обнаруживает three-way conflict (storedHash != localHash != serverHash)
   и открывает модалку.
5. Проверить все три ветки: **Keep server**, **Keep local**, **Keep both**.
   - Keep both: проверить, что появился `image.conflict-<ts>.png`.

### S7 — Delete-vs-update conflict

1. На S1 редактировать файл (есть несохранённые изменения).
2. На S2 удалить тот же файл.
3. На S1 — модалка delete-vs-update.
4. **Restore on server** → файл переоткрывается на сервере, оба vault'а
   снова видят его.

### S8 — Long offline

1. На S1 отключить интернет.
2. Сделать 50+ правок (новый файл, модификация, удаление, пере­именование).
3. Подождать 1+ час (или просто перезапустить плагин через
   Settings → Community plugins → toggle).
4. Включить интернет.
5. Драйн очереди должен пройти за разумное время; status bar показывает
   `syncing` пока pending не дренаж­нётся.
6. Проверить что все правки применились на сервере.

### S9 — Status bar + commands

- Status bar реагирует на изменение state (отключи Wi-Fi, цвет/иконка
  меняется).
- Click → меню: Sync now / Pause / History / Settings.
- Cmd-P:
  - "Team Vault: Pause" — после клика status bar → `paused`.
  - "Team Vault: Resume" — обратно.
  - "Team Vault: Sync now" → notice «Синхронизация завершена».
  - "Team Vault: Active file history" — открывает правую панель.
  - "Team Vault: Open settings" — фокус на settings tab.

### S10 — Log buttons

1. Settings → Team Vault → Behavior → log level: **debug**.
2. Сделать пару правок.
3. Click "Открыть лог" → открывается новый vault-файл с содержимым
   `sync.log` в код-фенсе.
4. Click "Очистить лог" → notice «Лог очищен», новый "Открыть лог"
   возвращает почти пустой файл (только текущая сессия).

### S11 — Stress test (1000+ files)

1. Создать в vault'е 1000 файлов (`for i in {1..1000}; do echo "f$i" > "f$i.md"; done`).
2. Bind → засечь время до `connected`.
3. Должно быть в разумных пределах (< 1 минуты на локалке).

## When done

Заполнить чек-лист (галочки рядом с каждым S1-S11). Найденные баги
фиксить как issues или сразу патчить + добавлять regression-тесты в
`tests/`.

После прохода S1-S10 (S11 — желательно но не блокирующий) — можно
тегать `v0.1.0` и запускать release workflow (см. README §Development).
