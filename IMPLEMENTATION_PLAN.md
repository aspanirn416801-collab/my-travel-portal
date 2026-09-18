# 旅遊手冊系統 20260918_13 局部優化技術實作計畫

本計畫針對驗收時發現的「身分恢復過渡」、「PIN 鎖定手冊提前請求風暴」、「GAS 每次開試算表延遲」與「空日期覆蓋」等 4 項具體問題進行精準局部優化。本計畫嚴格遵守工程安全規範，實作範圍嚴格鎖定於上述 4 項目標，絕不夾帶任何無關的介面或架構重構。

---

## 一、核心架構限制與設計規範

### 1. authStatus 與 verifiedRole 雙軌徹底分離（杜絕假性提權）
- **顯示狀態軌 (`authStatus`)**：`"guest" | "verifying" | "authenticated" | "auth-error"`
  - 僅用於頂部 UI 膠囊與提示文字渲染，絕不用於任何門禁或權限判斷。
  - 本機 Token 存在且未逾期時，初始化設為 `"verifying"`。
  - `sessionStorage` 的 `auth_role_hint` 僅限於在 `verifying` 期間顯示「正在恢復身分...」，**嚴禁**賦予任何實際權限。
- **實質權限軌 (`verifiedRole`)**：`"guest" | "user" | "admin"`
  - **唯一權限來源**：只能由本次 GAS 成功回應更新。
  - 門禁函式 `isTripUnlocked`、`canEditCurrentTrip` 以及管理員後台入口，全數綁定 `verifiedRole`，絕不信任本地 Storage。
- **異常狀態處置**：若 GAS 逾時或連線失敗，有效 Token 轉為 `authStatus = "auth-error"`，顯示「身分驗證逾時，點擊重試」，不清除 Token 也不降級為訪客。

### 2. GAS 底層原子資料快取與動態權限組裝（嚴禁快取完整 bootstrap）
- **禁止事項**：嚴禁直接快取以 `tripUuid` 為 Key 的完整 bootstrap 回應，避免訪客取得管理員或成員的免 PIN / `canEdit: true` 回應。
- **底層原子快取設計**：
  | 快取項目 | Cache Key 結構 | 快取內容 | TTL |
  | :--- | :--- | :--- | :---: |
  | **公開行程清單** | `public_trips_v1` | 僅含 uuid、name、hasPassword、日期天數（無密碼、無 email、無 sheetId） | 600s |
  | **行程伺服端 Meta** | `trip_meta_<uuid>` | 包含 targetSheetId、allowedUsersStr、tripPassword（伺服端內部比對用） | 600s |
  | **帳號權限版本** | `access_<emailHash>_<accessRevision>` | 該 Email 的角色與授權行程清單（以持久化版本號隔離） | 300s |
  | **手冊純內容** | `trip_content_<uuid>` | 純手冊內容資料（剔除 PIN、成員名單與 Sheet ID） | 300s |
- **動態組裝流程**：
  收到請求 ➔ 查閱原子快取 ➔ 驗證當前 Token 身分與 PIN ➔ 動態計算當前使用者之 `role` 與 `canEdit` ➔ 組裝專屬回應輸出。

### 3. 快取檢查嚴格前置於 `SpreadsheetApp.openById()` 之前（客觀速度描述）
- 在 `gas-code.js` 的 `doGet(e)` 最開頭即進行快取檢查。
- 訪客公開大廳請求（`action === "getTrips"` 且未帶 token）：快取命中時直接回傳，**避免執行 `SpreadsheetApp.openById()`**；實際速度依 GAS 冷啟動及網路狀態而異。
- 帶 Token 請求：先查 Token 驗證快取與 Email 權限快取，僅在 Cache Miss 時才開啟 `MASTER_SHEET_ID` 試算表。

### 4. accessRevision 儲存於 ScriptProperties 並使用 LockService 併發保護
- **持久化儲存**：權限版本號 `ACCESS_REVISION` 存放於 `PropertiesService.getScriptProperties()`，絕不依賴會被淘汰的 CacheService。
- **LockService 併發鎖**：修改成員名單或行程權限時，使用 `LockService.getScriptLock()` 等待至多 10 秒，防止並發更新遺失版本號：
  ```javascript
  function getAccessRevision() {
    const props = PropertiesService.getScriptProperties();
    return props.getProperty("ACCESS_REVISION") || "1";
  }

  function bumpAccessRevision() {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const props = PropertiesService.getScriptProperties();
      const current = Number(props.getProperty("ACCESS_REVISION") || "1");
      props.setProperty("ACCESS_REVISION", String(current + 1));
    } finally {
      lock.releaseLock();
    }
  }
  ```

### 5. 嚴格固定的寫入與失效順序（防讀取異常與降級）
- **操作順序**：
  1. 先完成 Google 試算表寫入
  2. 確認試算表寫入成功
  3. 清除內容快取／遞增權限版本號
  4. 回傳成功
  （絕不於寫入前提前清快取，寫入失敗時絕不遞增版本號）。
- **快取讀取防護與降級**：
  ```javascript
  let cached = null;
  try {
    cached = cache.get(cacheKey);
  } catch (error) {
    cached = null;
  }
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove(cacheKey);
    }
  }
  return readFromSpreadsheet(); // 任何異常均能安全回退讀取試算表
  ```

### 6. CacheService 90KB 容量安全保護
- 在將手冊或資料寫入快取前，檢查位元組長度：
  ```javascript
  const serialized = JSON.stringify(data);
  const bytes = Utilities.newBlob(serialized).getBytes().length;
  if (bytes < 90000) {
    cache.put(key, serialized, ttl);
  } else {
    console.warn("手冊內容超過 90KB，安全略過 CacheService，採用試算表直讀");
  }
  ```
- 保留完整降級備援，即便 Cache Miss 或超過 90KB，皆能正常從試算表讀取。

### 7. PIN 門禁嚴格阻斷與雙重流水號防護
- **未解鎖絕不 fetch**：
  ```javascript
  if (hasPassword && !isTripUnlocked(currentTripUuid, hasPassword)) {
    showLockedView(trip || { uuid: currentTripUuid, name: (trip && trip.name) || currentTripUuid });
    return; // 嚴格 return，絕不呼叫 fetchTripData()！
  }
  ```
- **提交 PIN 雙重比對防競態**：
  ```javascript
  const requestedUuid = currentTripUuid;
  const sequence = ++tripRequestSequence;
  const result = await verifyPin(inputPin);
  if (requestedUuid !== currentTripUuid || sequence !== tripRequestSequence) {
    return; // 舊回應直接丟棄
  }
  ```
- **bootstrap 回應防空發**：當 `!result.currentTrip` 時，必須先檢查 `isTripUnlocked(requestedTripUuid, hasPassword)`，若仍未解鎖，絕不發動 `fetchTripData()`。

### 8. 空日期三層 Fallback 機制
- 前端 `fetchTrips` 更新清單時，杜絕空字串覆蓋既有資訊：
  ```javascript
  const existing = tripsList.find((item) => item.uuid === t.uuid);
  const fallback = PUBLIC_TRIP_SUMMARIES.find((item) => item.uuid === t.uuid);

  startDate: t.startDate || existing?.startDate || fallback?.startDate || "",
  endDate: t.endDate || existing?.endDate || fallback?.endDate || "",
  duration: t.duration || existing?.duration || fallback?.duration || ""
  ```

---

## 二、變更檔案清單

1. **[app.js](file:///c:/Users/ellaq/Downloads/my-travel-portal-main/app.js)**
   - 引進 `authStatus` 與 `verifiedRole` 雙軌管理。
   - `navigateTo` 鎖定分支加入 `return`，阻斷手冊提前加載。
   - 提交 PIN 加入雙重流水號防護。
   - bootstrap 結果處理加入解鎖狀態檢查與三層日期 fallback。
   - 未授權 Google 登入者文字顯示為「👤 已登入（未授權）」。
   - 版本號提升至 `20260918_13`。
2. **[index.html](file:///c:/Users/ellaq/Downloads/my-travel-portal-main/index.html)**
   - 腳本標籤升級至 `?v=20260918_13`。
3. **[trip-state.js](file:///c:/Users/ellaq/Downloads/my-travel-portal-main/trip-state.js)**
   - 版本號提升至 `20260918_13`。
4. **[gas-code.js](file:///c:/Users/ellaq/Downloads/my-travel-portal-main/gas-code.js)**
   - `doGet` 開頭前置 CacheService 判斷，公開大廳直接命中回傳，跳過 `openById`。
   - 實作原子快取：`public_trips_v1`、`trip_meta_<uuid>`、`access_<emailHash>_<rev>`、`trip_content_<uuid>`。
   - 實作 `PropertiesService` + `LockService` 之 `getAccessRevision()` 與 `bumpAccessRevision()`。
   - 實作 90KB 容量檢查安全寫入函式 `safePutCache()`。
   - 實作嚴格寫入成功後之快取清除順序。
5. **[verify_v13_regression.js](file:///c:/Users/ellaq/Downloads/my-travel-portal-main/verify_v13_regression.js)**
   - 包含 12 項測試：雙軌狀態分離、鎖定分支無 fetchTripData、90KB 快取防護、GAS 快取前置於 openById、LockService 併發鎖與三層日期 fallback 等。
6. **[WALKTHROUGH.md](file:///c:/Users/ellaq/Downloads/my-travel-portal-main/WALKTHROUGH.md)**
   - 更新版本紀錄與兩步部署操作指南。

---

## 三、部署兩步流程說明

本次修改涉及 `gas-code.js`，發布時必須執行兩步部署：
1. **GitHub Pages 部署**：Git Push 前端 `_13` 程式碼。
2. **Google Apps Script 重新部署**：
   - 進入 Apps Script 編輯器，更新 `gas-code.js` 程式碼。
   - 點擊「部署」➔「管理部署作業」➔ 編輯現有 Web App ➔ 選擇「建立新版本」➔ 儲存發布。

---

## 四、驗收標準（10 大檢驗條件）

| 情境 | 通過條件 |
| :--- | :--- |
| **有效 Token 返回網站** | 不顯示訪客，立即顯示「正在恢復身分...」 |
| **GAS 暫時失敗** | 顯示「身分驗證逾時，點擊重試」，不清除有效 Token，不打回訪客 |
| **訪客首頁** | GAS 快取命中時 100% 避免執行 `SpreadsheetApp.openById()` |
| **PIN 鎖定頁** | 輸入 PIN 之前，Network 面板絕不發送 `getTripData` |
| **PIN 送出** | 僅產生一支驗證請求，舊回應不回鎖畫面 |
| **成員遭移除** | 試算表寫入成功後遞增 `ACCESS_REVISION`，舊快取即刻失效 |
| **冷快取** | Cache miss 或異常時順利回退讀取試算表，不報錯 |
| **大型行程** | 超過 90KB 時安全略過快取，保留試算表正常讀寫 |
| **空日期資料** | 試算表日期空白時，由三層 Fallback 自動填補，首頁天數絕不消失 |
| **未授權登入者** | 無任何行程 `canEdit` 權限之 Google 帳號顯示「已登入（未授權）」 |
