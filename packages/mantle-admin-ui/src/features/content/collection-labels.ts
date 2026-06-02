import type { AdminLanguage } from "../../app/preferences";
import type { Collection } from "../../lib/types";

const LABELS: Record<string, Partial<Record<AdminLanguage, string>>> = {
  products: {
    en: "Products",
    "zh-TW": "商品",
    "zh-CN": "商品",
  },
  "product-skus": {
    en: "Product SKUs",
    "zh-TW": "商品規格",
    "zh-CN": "商品规格",
  },
  pages: {
    en: "Pages",
    "zh-TW": "頁面",
    "zh-CN": "页面",
  },
  orders: {
    en: "Orders",
    "zh-TW": "訂單",
    "zh-CN": "订单",
  },
  order_items: {
    en: "Order line items",
    "zh-TW": "訂單明細",
    "zh-CN": "订单明细",
  },
  inventory_snapshots: {
    en: "Inventory snapshots",
    "zh-TW": "庫存快照",
    "zh-CN": "库存快照",
  },
};

const DESCRIPTIONS: Record<string, Partial<Record<AdminLanguage, string>>> = {
  products: {
    en: "Manage product records, publishing state, and localized product copy.",
    "zh-TW": "管理商品資料、發布狀態與多語商品內容。",
    "zh-CN": "管理商品资料、发布状态与多语商品内容。",
  },
  "product-skus": {
    en: "Manage sellable variants, prices, inventory mode, and product options.",
    "zh-TW": "管理可販售規格、價格、庫存模式與商品選項。",
    "zh-CN": "管理可销售规格、价格、库存模式与商品选项。",
  },
  pages: {
    en: "Manage storefront pages, layout sections, and localized page copy.",
    "zh-TW": "管理前台頁面、首頁區塊與多語文案。",
    "zh-CN": "管理前台页面、首页区块与多语文案。",
  },
  orders: {
    en: "Review customer orders and fulfillment state.",
    "zh-TW": "查看客戶訂單與履約狀態。",
    "zh-CN": "查看客户订单与履约状态。",
  },
  order_items: {
    en: "Review purchased items captured at checkout time.",
    "zh-TW": "查看結帳當下保存的購買項目明細。",
    "zh-CN": "查看结账当下保存的购买项目明细。",
  },
  inventory_snapshots: {
    en: "Review inventory snapshots synced from the inventory actor.",
    "zh-TW": "查看由庫存 actor 同步的庫存快照。",
    "zh-CN": "查看由库存 actor 同步的库存快照。",
  },
};

export function collectionTitle(collection: Collection, language: AdminLanguage): string {
  return LABELS[collection.name]?.[language] ?? collection.title;
}

export function collectionDescription(
  collection: Collection | undefined,
  language: AdminLanguage,
): string | null {
  if (!collection) return null;
  return DESCRIPTIONS[collection.name]?.[language] ?? collection.description;
}
