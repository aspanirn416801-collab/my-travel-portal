# 旅遊手冊系統 20260918_13 局部優化驗收指引與全生命週期操作手冊

本文件詳細記錄 `20260918_13` 版本之後端快取全覆蓋與身分雙軌化核心修復：
1. **P0 登入流程狀態即時重設**：`handleCredentialResponse()` 立即設定 `authStatus = "verifying"`、`verifiedRole = "guest"`、`userRole = "guest"` 並清空 `tripPermissions`，重試時同步更新，徹底防止訪客畫面閃爍。
2. **P0 `trip_meta_<uuid>` 實作原子讀寫**：伺服端建立共用函式 `getTripMetaCached`，`bootstrap` 與 `getTripData` 統一調用，快取 600 秒，命中時無需開主控表。
3. **P0 `getTripData` 導入手冊內容快取**：通過門禁驗證後，優先讀取 `trip_content_<uuid>` 快取（300 秒），消除 PIN 訪客解鎖後需等待 20 多秒的痛點。
4. **P1 `getUserAccess()` 重用試算表實例**：支援傳入既有 `masterSpreadsheet` 與 `tripRows`，徹底消除 Cache Miss 時重複開表問題。
5. **P1 雙軌門禁徹底分離**：`canEditCurrentTrip()`、`isTripUnlocked()`、`showAdminView()`、`openAdminView()` 均改用 `verifiedRole` 嚴格判定，登入前與驗證失敗時即刻清空 `tripPermissions`。

---

## 一、本次 20260918_13 核心缺陷修復對照表

| 項目 | 修正前現象 | 20260918_13 具體重構解法 | 實測驗證 |
| :--- | :--- | :--- | :--- |
| **P0：新登入狀態** | 登入回調僅改 `userRole` 未改 `authStatus`，新登入短暫落入訪客已登入。 | `handleCredentialResponse` 推進 `authGeneration`、清空 `tripPermissions`，設定 `authStatus = "verifying"`、`verifiedRole = "guest"`；重試時亦同步重設。 | **通過 (動態行為實測驗證)** |
| **P0：trip_meta 讀寫** | 僅有清除快取，未實作 `safeGetCache` 與 `safePutCache`，端點仍重複開表。 | 建立 `getTripMetaCached(tripUuid, tripRows)` 與 `findTripMetaFromRows`，`bootstrap` 與 `getTripData` 統一調用，快取 600 秒。 | **通過 (0 開表行為實測)** |
| **P0：getTripData 快取** | 通過 PIN 驗證後直接 `loadTripDetails`，訪客仍需等待 20 多秒。 | 門禁通過後，優先讀取 `safeGetCache("trip_content_" + tripUuid)`，未命中才載入子表並安全快取 300 秒。 | **通過 (loadTripDetails 0 呼叫實測)** |
| **P1：getUserAccess 開表** | `doGet` 已開主控表，`getUserAccess` 內部再次 `openById`，造成重複開表。 | `getUserAccess(email, masterSpreadsheet, tripRows)` 重用傳入實例與 rows，不再重複開啟試算表。 | **通過 (參數相容與開表去重實測)** |
| **P1：雙軌門禁分離** | 門禁函式仍讀取 `userRole`，驗證失敗未清空 `tripPermissions`。 | `canEditCurrentTrip` 綁定 `authStatus === "authenticated"` 與 `verifiedRole`，門禁轉接注入 `verifiedRole`，失敗時清空授權。 | **通過 (權限隔離單元實測)** |

---

## 二、20260918_13 操作型回歸測試結果 (12/12 通過)

在專案目錄下執行：
```powershell
node verify_v13_regression.js
```

| 項次 | 檢驗指標 | 檢測內容與判定標準 | 檢測結果 |
| :---: | :--- | :--- | :--- |
| 1 | **版本標籤一致性** | `app.js`、`index.html`、`trip-state.js` 均為 `20260918_13` | **通過** |
| 2 | **身分雙軌行為實測** | 新登入即刻設定 `authStatus=verifying`、清空舊授權，驗證完成前 100% 阻斷編輯 | **通過** |
| 3 | **門禁轉接單元實測** | 正式呼叫點扣除定義後精確等於 9 處，管理員/成員/PIN 放行邏輯正確 | **通過** |
| 4 | **PIN 鎖定嚴格阻斷** | 鎖定分支直接 `return` 絕無手冊請求，PIN 提交具備雙重流水號防護 | **通過** |
| 5 | **端點選擇分流** | 未登入訪客進 PIN 行程改發 `getTrips` 命中快取，有 Token 才發 `bootstrap` | **通過** |
| 6 | **空日期三層 Fallback** | 依序由後端值 ➔ 既有快取值 ➔ 預設公開摘要自動填補，防空白覆蓋 | **通過** |
| 7 | **Cache Hit 0 開表行為實測** | `SpreadsheetApp.openById` 拋錯仍能成功回應，`loadTripDetails` 呼叫 0 次 | **通過** |
| 8 | **ScriptProperties 持久化** | 權限版本號存放於 ScriptProperties，遞增採 10 秒 LockService 原子鎖 | **通過** |
| 9 | **90KB 容量安全保護** | `safePutCache` 檢查位元組 `< 90000`，超量手冊安全略過快取改為試算表直讀 | **通過** |
| 10 | **完整快取失效矩陣** | `updateTripMeta` 支援各欄位累加判定失效，新增行程遞增版本號 | **通過** |
| 11 | **未授權帳號文字校正** | 無任何行程 `canEdit` 權限之 Google 帳號顯示為「已登入 (未授權)」 | **通過** |
| 12 | **登出世代防舊回應回填** | 登出時遞增世代號阻斷延遲非同步回應重建快照與 Session | **通過** |

---

## 三、三項關鍵線上讀取速度情境預期

| 測試情境 | 後端快取命中鏈 | 試算表開銷 | 預期表現 |
| :--- | :--- | :--- | :--- |
| **1. 訪客首頁第二次讀取** | `public_trips_v1` 命中 | **0 開表** (完全不開主控表) | 秒開大廳卡片 |
| **2. PIN 第二次開啟手冊** | `trip_meta` + `trip_content` 命中 | **0 開表** (不開主表、不開子表，純比對 PIN) | 立即解鎖手冊 |
| **3. 管理員/成員返回行程** | `access` + `trip_meta` + `trip_content` 命中 | **0 開表** (驗證 Token 後直接回傳) | 立即呈現手冊 |

---

## 四、兩步部署操作指南

本次升級包含前端與後端 GAS，發布時必須依序完成：

### 第一步：GitHub Pages 前端部署
1. 本地程式碼已通過全量回歸測試。
2. 執行 `git push origin main` 將最新程式碼推送到 GitHub。
3. GitHub Pages 自動建置完成後，正式線上將同步載入更新。

### 第二步：Google Apps Script 重新部署 Web App (關鍵！)
1. 開啟您的 Google Apps Script 專案編輯器。
2. 將本專案中的 [`gas-code.js`](./gas-code.js) 完整內容複製，覆蓋 Apps Script 中的程式碼。
3. 點擊右上角 **「部署」** ➔ **「管理部署作業」**。
4. 點選現有的 Web App 部署項目，點擊鉛筆圖示（編輯）。
5. 在「版本」下拉選單中選擇 **「建立新版本」**（版本說明可填：`20260918_13 快取全覆蓋與雙軌門禁修復`）。
6. 點擊 **「部署」** 儲存發布。
   > [!IMPORTANT]
   > 必須選擇「建立新版本」並點擊部署，GAS 網頁應用程式才會真正運行最新的原子快取與 0 開表邏輯！
