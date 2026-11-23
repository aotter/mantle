import type { FieldLabels } from "@aotter/mantle-ui/kit";
import type { InteractionLabels } from "@aotter/mantle-ui";
import { normalizeLanguage } from "../app/languages";
import { adminLabels } from "./admin-labels.generated";
import { viewLabels } from "./locale-view";
import { uploadCopy } from "./locale-upload";

/** Strings the App renders around the shared components. */
export interface AppLabels {
  readonly interaction: InteractionLabels;
  /** The form's own strings, as Admin's. */
  readonly fields: FieldLabels;
  /** The entry's own timestamps, which no Schema titles. */
  readonly created: string;
  readonly updated: string;
  readonly waiting: string;
  readonly nothing: string;
  readonly viewFailed: string;
  readonly viewCancelled: string;
  readonly refreshFailed: string;
  readonly loadMore: string;
  readonly loadMoreFailed: string;
  /** `{count}` is the number of rows added. */
  readonly rowsLoaded: string;
  readonly exportCsv: string;
  /** The host refused the download, or the person cancelled it: its answer does not say which. */
  readonly exportFailed: string;
  /** No answer came: the host's download dialog may still be open, so this is not a failure. */
  readonly exportUnconfirmed: string;
  readonly fullscreen: string;
  /** Back from the side panel or full screen: a host reports `fullscreen` for both, so it names neither. */
  readonly toConversation: string;
  /** The host answered a display mode request with the mode the App already had. */
  readonly displayRefused: string;
  /** Inline under the host's height cap, opening the rest in full screen; `{count}` is the number of rows not shown. */
  readonly moreRows: string;
}

type ViewLabels = Omit<AppLabels, "fields" | "interaction">;
const APP_LABELS: Readonly<Record<"en" | "zh-TW" | "zh-CN", ViewLabels>> = {
  "en": {
    created: "Created",
    updated: "Updated",
    waiting: "Waiting for results…",
    nothing: "Nothing to show.",
    viewFailed: "These results could not be shown.",
    viewCancelled: "The request was cancelled.",
    refreshFailed: "The list could not be refreshed. It may be out of date.",
    loadMore: "Load more",
    loadMoreFailed: "More results could not be loaded.",
    rowsLoaded: "{count} more loaded",
    exportCsv: "Export CSV",
    exportFailed: "The download did not finish.",
    exportUnconfirmed: "The download could not be confirmed. Check for an open download dialog before exporting again.",
    fullscreen: "Full screen",
    toConversation: "Back to the conversation",
    displayRefused: "The host kept the current view.",
    moreRows: "{count} more: open full screen",
  },
  "zh-TW": {
    created: "建立時間",
    updated: "更新時間",
    waiting: "正在等待結果…",
    nothing: "沒有可顯示的內容。",
    viewFailed: "無法顯示這些結果。",
    viewCancelled: "請求已取消。",
    refreshFailed: "無法重新整理清單，內容可能不是最新的。",
    loadMore: "載入更多",
    loadMoreFailed: "無法載入更多結果。",
    rowsLoaded: "已載入 {count} 筆",
    exportCsv: "匯出 CSV",
    exportFailed: "下載未完成。",
    exportUnconfirmed: "無法確認是否已下載。再次匯出前，請先查看是否有開啟中的下載對話框。",
    fullscreen: "全螢幕",
    toConversation: "返回對話",
    displayRefused: "主機維持目前的顯示方式。",
    moreRows: "還有 {count} 筆：以全螢幕開啟",
  },
  "zh-CN": {
    created: "创建时间",
    updated: "更新时间",
    waiting: "正在等待结果…",
    nothing: "没有可显示的内容。",
    viewFailed: "无法显示这些结果。",
    viewCancelled: "请求已取消。",
    refreshFailed: "无法刷新列表，内容可能不是最新的。",
    loadMore: "加载更多",
    loadMoreFailed: "无法加载更多结果。",
    rowsLoaded: "已加载 {count} 条",
    exportCsv: "导出 CSV",
    exportFailed: "下载未完成。",
    exportUnconfirmed: "无法确认是否已下载。再次导出前，请先查看是否有打开的下载对话框。",
    fullscreen: "全屏",
    toConversation: "返回对话",
    displayRefused: "主机保持当前的显示方式。",
    moreRows: "还有 {count} 条：以全屏打开",
  },
};

/** Use the host locale and the same English fallback as Admin for strings that lack translations. */
export function appLabels(locale: string | undefined): AppLabels {
  const tag = (locale ?? "").toLowerCase();
  const language = tag === "zh" ? "zh-CN" : normalizeLanguage(locale);
  const { fields, interaction, viewFailed } = adminLabels[language];
  const form = {
    fields: { ...adminLabels.en.fields, ...fields },
    interaction: { ...adminLabels.en.interaction, ...interaction },
  };
  if (language === "zh-TW" || language === "zh-CN" || language === "en") return { ...APP_LABELS[language], ...form };
  const { submit, submitting, ...view } = viewLabels[language];
  return {
    ...APP_LABELS.en,
    ...view,
    ...form,
    viewFailed,
    interaction: { ...form.interaction, submit, submitting },
  };
}

const UPLOAD_EN = {
  library: "Media library",
  title: "Upload a file",
  intro: "Add the original file to your media library.",
  purpose: "Purpose",
  file: "File",
  choose: "Choose a file",
  browse: "Browse your device",
  noFile: "No file selected",
  alt: "Alt text",
  altHint: "A short description for people who cannot see the image.",
  altPlaceholder: "Describe the image",
  upload: "Upload",
  preparing: "Preparing…",
  uploading: "Uploading…",
  uploadingFile: "Uploading {filename}…",
  committing: "Committing…",
  saving: "Saving…",
  uploaded: "Uploaded",
  retry: "Try again",
  progress: "Upload progress",
  footnote: "Keep this card open until the upload finishes.",
  bytes: "{count} bytes",
  upTo: "Up to {size}",
  typeLimit: "{type} up to {size}",
  anyFile: "Any file type",
  anyImage: "Any image",
  multiVariants: "This purpose needs several variants. Ask the agent to prepare them.",
  connecting: "Connecting to the MCP host…",
  unknownPurpose: "The purpose '{purpose}' is not declared.",
  toolsUnavailable: "This host does not let the card call tools.",
  complete: "Uploaded. Asset id {id}.",
  storageFailed: "Storage answered {status}.",
  storageUnavailable: "Storage could not be reached. Its CORS rules must allow PUT from this host.",
  variantsNeeded: "'{purpose}' takes {count} variants ({types}); ask the agent to prepare and upload them.",
  mimeRejected: "'{purpose}' takes {types}, not {type}.",
  or: " or ",
  tooLarge: "The file is {size} bytes; '{purpose}' takes at most {max}.",
  prepareFailed: "The upload could not be prepared.",
  targetMissing: "The server answered without an upload target.",
  commitFailed: "The upload could not be committed.",
  policyFailed: "The media purposes could not be read.",
  connectionFailed: "The MCP host connection failed.",
  completionMessage: "I uploaded {filename} to the media library: asset id {id} (purpose {purpose}).",
};

export type UploadLabels = { readonly [Key in keyof typeof UPLOAD_EN]: string };
const UPLOAD_LABELS: Readonly<Record<"en" | "zh-TW" | "zh-CN", UploadLabels>> = {
  en: UPLOAD_EN,
  "zh-TW": {
    library: "媒體庫",
    title: "上傳檔案",
    intro: "將原始檔案加入媒體庫。",
    purpose: "用途",
    file: "檔案",
    choose: "選擇檔案",
    browse: "瀏覽裝置中的檔案",
    noFile: "尚未選擇檔案",
    alt: "替代文字",
    altHint: "提供簡短說明，讓無法看見圖片的人也能理解。",
    altPlaceholder: "描述這張圖片",
    upload: "上傳",
    preparing: "準備中…",
    uploading: "上傳中…",
    uploadingFile: "正在上傳 {filename}…",
    committing: "正在儲存…",
    saving: "儲存中…",
    uploaded: "已上傳",
    retry: "重試",
    progress: "上傳進度",
    footnote: "上傳完成前，請保持此卡片開啟。",
    bytes: "{count} 位元組",
    upTo: "上限 {size}",
    typeLimit: "{type} 上限 {size}",
    anyFile: "任何檔案類型",
    anyImage: "任何圖片",
    multiVariants: "此用途需要多個版本，請讓助理準備。",
    connecting: "正在連線至 MCP 主機…",
    unknownPurpose: "未宣告用途「{purpose}」。",
    toolsUnavailable: "此主機不允許卡片呼叫工具。",
    complete: "上傳完成。素材 ID：{id}。",
    storageFailed: "儲存服務回應 {status}。",
    storageUnavailable: "無法連線至儲存服務。其 CORS 規則必須允許此主機的 PUT 請求。",
    variantsNeeded: "「{purpose}」需要 {count} 個版本（{types}），請讓助理準備並上傳。",
    mimeRejected: "「{purpose}」接受 {types}，不接受 {type}。",
    or: " 或 ",
    tooLarge: "檔案為 {size} 位元組；「{purpose}」上限為 {max}。",
    prepareFailed: "無法準備上傳。",
    targetMissing: "伺服器未提供上傳目標。",
    commitFailed: "無法完成上傳儲存。",
    policyFailed: "無法讀取媒體用途。",
    connectionFailed: "MCP 主機連線失敗。",
    completionMessage: "我已將 {filename} 上傳至媒體庫：素材 ID {id}（用途 {purpose}）。",
  },
  "zh-CN": {
    library: "媒体库",
    title: "上传文件",
    intro: "将原始文件加入媒体库。",
    purpose: "用途",
    file: "文件",
    choose: "选择文件",
    browse: "浏览设备中的文件",
    noFile: "尚未选择文件",
    alt: "替代文本",
    altHint: "提供简短说明，让无法看见图片的人也能理解。",
    altPlaceholder: "描述这张图片",
    upload: "上传",
    preparing: "准备中…",
    uploading: "上传中…",
    uploadingFile: "正在上传 {filename}…",
    committing: "正在保存…",
    saving: "保存中…",
    uploaded: "已上传",
    retry: "重试",
    progress: "上传进度",
    footnote: "上传完成前，请保持此卡片打开。",
    bytes: "{count} 字节",
    upTo: "上限 {size}",
    typeLimit: "{type} 上限 {size}",
    anyFile: "任何文件类型",
    anyImage: "任何图片",
    multiVariants: "此用途需要多个版本，请让助手准备。",
    connecting: "正在连接至 MCP 主机…",
    unknownPurpose: "未声明用途“{purpose}”。",
    toolsUnavailable: "此主机不允许卡片调用工具。",
    complete: "上传完成。素材 ID：{id}。",
    storageFailed: "存储服务响应 {status}。",
    storageUnavailable: "无法连接至存储服务。其 CORS 规则必须允许此主机的 PUT 请求。",
    variantsNeeded: "“{purpose}”需要 {count} 个版本（{types}），请让助手准备并上传。",
    mimeRejected: "“{purpose}”接受 {types}，不接受 {type}。",
    or: " 或 ",
    tooLarge: "文件为 {size} 字节；“{purpose}”上限为 {max}。",
    prepareFailed: "无法准备上传。",
    targetMissing: "服务器未提供上传目标。",
    commitFailed: "无法完成上传保存。",
    policyFailed: "无法读取媒体用途。",
    connectionFailed: "MCP 主机连接失败。",
    completionMessage: "我已将 {filename} 上传至媒体库：素材 ID {id}（用途 {purpose}）。",
  },
};

/** The upload card follows the same host locale and fallback as the Admin MCP App. */
export function uploadLabels(locale: string | undefined): UploadLabels {
  const tag = (locale ?? "").toLowerCase();
  const language = tag === "zh" ? "zh-CN" : normalizeLanguage(locale);
  if (language === "en" || language === "zh-TW" || language === "zh-CN") return UPLOAD_LABELS[language];
  const copy = uploadCopy[language];
  return {
    ...UPLOAD_EN,
    ...copy,
    progress: copy.uploading,
    uploadingFile: `${copy.uploading} {filename}`,
    committing: copy.saving,
    typeLimit: `{type} · ${copy.upTo}`,
    completionMessage: `{filename} · ${copy.complete} · {purpose}`,
  };
}
