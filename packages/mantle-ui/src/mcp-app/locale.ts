import type { InteractionLabels } from "../react/labels.js";

/** Strings the App renders around the shared components. */
export interface AppLabels {
  readonly interaction: InteractionLabels;
  readonly waiting: string;
  readonly nothing: string;
  readonly viewFailed: string;
  readonly viewCancelled: string;
  readonly refreshFailed: string;
  readonly preview: string;
}

const APP_LABELS: Readonly<Record<"en" | "zh-TW" | "zh-CN", AppLabels>> = {
  "en": {
    interaction: {
      submit: "Run",
      submitting: "Running…",
      cancel: "Cancel",
      close: "Close",
      boundInputs: "From the selected row",
      reviewedEntry: "Entry you are reviewing",
      version: "Version",
      changes: "Your changes",
      latestChanges: "What changed",
      field: "Field",
      before: "Before",
      after: "After",
      empty: "—",
      loading: "Loading the latest version…",
      reading: "Checking for changes…",
      unreadable: "This entry could not be loaded, so nothing can be submitted yet.",
      changedSinceList: "Someone changed this entry after you opened it. Review the newer version before you continue.",
      reviewLatest: "Review newer version",
      contested: "Someone else also changed fields you edited:",
      conflict: "This entry changed before your update was saved. Nothing was saved. Load the latest version and review it again.",
      conflictReopen: "This entry changed before your update was saved. Nothing was saved. Close this, then open the action again from the refreshed list.",
      uncertain: "We could not confirm whether this was saved. Check the latest version before trying again.",
      reread: "Load latest version",
      acknowledgeUncertain: "I checked; continue",
      failed: "This operation was refused.",
      succeeded: "Done.",
      cancelled: "Cancelled.",
    },
    waiting: "Waiting for results…",
    nothing: "Nothing to show.",
    viewFailed: "These results could not be shown.",
    viewCancelled: "The request was cancelled.",
    refreshFailed: "The list could not be refreshed. It may be out of date.",
    preview: "Preview",
  },
  "zh-TW": {
    interaction: {
      submit: "執行",
      submitting: "執行中…",
      cancel: "取消",
      close: "關閉",
      boundInputs: "來自選取的資料列",
      reviewedEntry: "你正在檢視的資料",
      version: "版本",
      changes: "你的變更",
      latestChanges: "變更內容",
      field: "欄位",
      before: "變更前",
      after: "變更後",
      empty: "—",
      loading: "正在載入最新版本…",
      reading: "正在檢查是否有變更…",
      unreadable: "無法載入這筆資料，暫時無法送出。",
      changedSinceList: "你開啟後這筆資料已被他人變更。請先檢視新版本再繼續。",
      reviewLatest: "檢視新版本",
      contested: "他人也變更了你編輯過的欄位：",
      conflict: "這筆資料在你的更新儲存前已變更，因此沒有儲存。請載入最新版本並重新檢視。",
      conflictReopen: "這筆資料在你的更新儲存前已變更，因此沒有儲存。請關閉後，從重新整理的清單再次開啟這個操作。",
      uncertain: "無法確認是否已儲存。請先檢查最新版本再重試。",
      reread: "載入最新版本",
      acknowledgeUncertain: "我已確認，繼續",
      failed: "這個操作被拒絕。",
      succeeded: "完成。",
      cancelled: "已取消。",
    },
    waiting: "正在等待結果…",
    nothing: "沒有可顯示的內容。",
    viewFailed: "無法顯示這些結果。",
    viewCancelled: "請求已取消。",
    refreshFailed: "無法重新整理清單，內容可能不是最新的。",
    preview: "預覽",
  },
  "zh-CN": {
    interaction: {
      submit: "执行",
      submitting: "执行中…",
      cancel: "取消",
      close: "关闭",
      boundInputs: "来自选中的数据行",
      reviewedEntry: "你正在查看的数据",
      version: "版本",
      changes: "你的更改",
      latestChanges: "更改内容",
      field: "字段",
      before: "更改前",
      after: "更改后",
      empty: "—",
      loading: "正在加载最新版本…",
      reading: "正在检查是否有更改…",
      unreadable: "无法加载这条数据，暂时无法提交。",
      changedSinceList: "你打开后这条数据已被他人更改。请先查看新版本再继续。",
      reviewLatest: "查看新版本",
      contested: "他人也更改了你编辑过的字段：",
      conflict: "这条数据在你的更新保存前已更改，因此没有保存。请加载最新版本并重新查看。",
      conflictReopen: "这条数据在你的更新保存前已更改，因此没有保存。请关闭后，从刷新后的列表再次打开这个操作。",
      uncertain: "无法确认是否已保存。请先检查最新版本再重试。",
      reread: "加载最新版本",
      acknowledgeUncertain: "我已确认，继续",
      failed: "这个操作被拒绝。",
      succeeded: "完成。",
      cancelled: "已取消。",
    },
    waiting: "正在等待结果…",
    nothing: "没有可显示的内容。",
    viewFailed: "无法显示这些结果。",
    viewCancelled: "请求已取消。",
    refreshFailed: "无法刷新列表，内容可能不是最新的。",
    preview: "预览",
  },
};

/**
 * The labels for the host's BCP 47 locale: Traditional Chinese for
 * `zh-Hant`, Taiwan, Hong Kong and Macau; Simplified Chinese for any
 * other `zh`; English otherwise.
 */
export function appLabels(locale: string | undefined): AppLabels {
  const tag = (locale ?? "").toLowerCase();
  if (!tag.startsWith("zh")) return APP_LABELS.en;
  return /^zh-(hant|tw|hk|mo)\b/u.test(tag) ? APP_LABELS["zh-TW"] : APP_LABELS["zh-CN"];
}
