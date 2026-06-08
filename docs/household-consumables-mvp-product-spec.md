# 家庭消耗品管理小程序 MVP 产品方案

版本：v0.1  
目标用户：两口之家 + 宠物家庭自用  
当前目标：先做一款可实际使用的微信小程序 MVP，不做 AI、不接电商、不做自动下单。  

---

## 1. 产品定位

这是一款用于管理家庭日常消耗品库存和补货提醒的小程序。

它不解决“买什么最便宜”，而是先解决一个更具体的问题：

> 家里常用的东西不要等到用完才发现，要在快递还来得及送达之前提醒补货。

第一版面向自用，不考虑推广、商业化、平台推荐和复杂供应链。核心是把家庭常用消耗品的库存、日均消耗速度、快递到货天数和安全缓冲天数录入后，系统自动计算剩余可用天数和最晚下单日。

---

## 2. 核心场景

### 2.1 普通家庭消耗品

典型商品：

- 卷纸
- 抽纸
- 厨房纸
- 垃圾袋
- 洗衣液
- 洗衣凝珠
- 洗洁精
- 洗手液
- 牙膏
- 保鲜袋
- 保鲜膜
- 净水器滤芯
- 扫地机器人耗材

### 2.2 宠物消耗品

家里有宠物，需要把宠物用品作为一级大类支持。

典型商品：

- 宠物粮
- 猫砂
- 宠物湿巾
- 尿垫
- 除臭喷雾
- 驱虫相关耗材
- 宠物洗护用品

宠物类消耗品的特点是：

- 缺货后替代成本高。
- 不能总靠临时外卖补货。
- 有些商品有固定品牌和规格，适合提前复购。
- 消耗速度相对稳定，适合用“库存 ÷ 日均消耗”估算。

---

## 3. MVP 范围

### 3.1 本期必须做

1. 商品库
   - 左侧一级大类
   - 右侧商品列表
   - 支持搜索商品
   - 支持新增一级大类
   - 支持新增商品
   - 支持编辑商品

2. 首页补货提醒
   - 展示“今天该买”
   - 展示“3 天内观察”
   - 展示“暂时安全”
   - 按最晚下单日排序

3. 商品详情 / 规则设置
   - 商品名称
   - 一级大类
   - 单位
   - 当前库存
   - 日均消耗
   - 快递到货天数
   - 安全缓冲天数
   - 提前提醒天数
   - 默认购买数量
   - 购买链接
   - 备注
   - 保存
   - 删除
   - 历史记录

4. 补货记录
   - 已买记录
   - 库存调整记录
   - 商品新增 / 删除记录
   - 一级大类新增 / 删除记录
   - 设置修改记录

5. 我的 / 设置
   - 家庭名称
   - 家庭人数
   - 默认快递天数
   - 默认安全缓冲天数
   - 一级大类管理
   - 重置演示数据

### 3.2 本期不做

- 不接 AI。
- 不做自动下单。
- 不接淘宝、拼多多、京东、美团 API。
- 不做价格监控。
- 不做多账号权限。
- 不做云同步。
- 不做复杂统计报表。
- 不做图片上传的真实存储，图片位置可先占位。
- 不做微信订阅消息，后续版本再考虑。

---

## 4. 信息架构

底部导航只保留 4 个主入口：

1. 首页
2. 商品库
3. 记录
4. 我的

不需要底部常驻“添加”入口。添加商品属于低频动作，入口放在商品库右上角。

### 4.1 首页

首页只承担补货提醒功能。

页面内容：

- 顶部概览卡片
  - 该买数量
  - 观察数量
  - 安全数量
- 今天该买
- 3 天内观察
- 暂时安全

商品提醒卡片展示：

- 商品名称
- 一级大类
- 当前库存
- 单位
- 预计剩余天数
- 最晚下单日
- 状态标签：该买了 / 观察 / 安全
- 快捷操作：已买、-1、还够用

点击商品卡片进入商品详情。

### 4.2 商品库

商品库是核心管理页面。

布局：

- 左侧：一级大类列表
- 右侧：商品列表
- 右上角：添加商品
- 左侧底部：+ 大类

默认一级大类：

- 全部
- 卫生间
- 厨房
- 洗衣清洁
- 个人护理
- 客厅/卧室
- 食品饮品
- 宠物用品
- 设备耗材

左侧一级大类要求：

- 点击一级大类后，右侧只展示该类商品。
- “全部”展示所有商品。
- 支持新增一级大类。
- 空大类可删除。
- 已有商品的大类不能直接删除。

右侧商品列表展示字段：

- 商品名称
- 当前库存 + 单位
- 预计剩余天数
- 最晚下单日
- 状态标签

商品列表按最晚下单日排序，越紧急越靠前。

### 4.3 商品详情

商品详情本质是规则设置页。

页面顶部：

- 图片占位
- 商品名称
- 一级大类
- 单位
- 状态标签
- 预计剩余天数
- 最晚下单日

表单字段：

基础信息：

- 商品名称
- 选择大类
- 单位

库存与提醒规则：

- 当前库存
- 日均消耗
- 快递到货天数
- 安全缓冲天数
- 提前提醒天数
- 默认购买数量

购买信息：

- 购买链接
- 备注

底部按钮：

- 删除
- 保存
- 历史记录

当前库存需要支持 `-` 和 `+` 快速调整。

### 4.4 添加商品

添加商品页面和商品详情页保持同构。

入口：商品库右上角“添加”。

默认规则：

- 如果当前在某个大类下点击添加，则默认选中该大类。
- 如果当前在“全部”下点击添加，则默认选中“卫生间”。
- 单位默认“件”。
- 快递天数使用家庭默认快递天数。
- 安全缓冲使用家庭默认安全缓冲天数。

### 4.5 记录

记录页展示所有操作流水。

记录类型：

- 新增商品
- 编辑商品
- 删除商品
- 已买
- 库存调整
- 还够用 / 顺延提醒
- 新增一级大类
- 删除一级大类
- 修改设置

记录字段：

- 记录 ID
- 类型
- 标题
- 描述
- 时间

商品详情页点击“历史记录”时，进入记录页并筛选当前商品相关记录。

### 4.6 我的

我的页主要做设置。

模块：

1. 家庭默认参数
   - 家庭名称
   - 家庭人数
   - 默认快递天数
   - 默认安全缓冲天数
   - 编辑默认参数

2. 一级大类管理
   - 展示所有一级大类
   - 展示每个大类下商品数量
   - 空大类可删除
   - 有商品的大类不可删除
   - 可新增一级大类

3. 原型操作
   - 重置演示数据

---

## 5. 核心计算规则

### 5.1 剩余可用天数

```ts
remainDays = stock / dailyUse
```

说明：

- `stock` 是当前库存。
- `dailyUse` 是日均消耗。
- 如果 `dailyUse <= 0`，前端需要阻止保存。

### 5.2 预计耗尽日期

```ts
exhaustDate = today + ceil(remainDays)
```

### 5.3 最晚下单日

```ts
latestOrderDate = exhaustDate - deliveryDays - bufferDays
```

说明：

- `deliveryDays` 是快递到货天数。
- `bufferDays` 是安全缓冲天数。

### 5.4 距离最晚下单日天数

```ts
daysToOrder = latestOrderDate - today
```

### 5.5 商品状态

```ts
if stock <= 0 or remainDays <= 0:
  status = "已断货"
elif daysToOrder <= 0:
  status = "该买了"
elif daysToOrder <= 3:
  status = "观察"
else:
  status = "安全"
```

### 5.6 快捷操作规则

#### 已买

点击“已买”后：

```ts
stock = stock + defaultBuyQty
```

并新增一条记录：

```ts
{
  type: "buy",
  title: "{商品名} 已买",
  desc: "按默认购买数量 +{defaultBuyQty}{unit}，当前库存 {stock}{unit}"
}
```

#### -1

点击 `-1` 后：

```ts
stock = max(0, stock - 1)
```

并新增库存调整记录。

#### 还够用

点击“还够用”后：

```ts
stock = stock + dailyUse * 7
```

含义：提醒顺延约 7 天。

并新增记录。

---

## 6. 数据结构

MVP 可以先使用本地存储，不接后端。

建议：

- 微信小程序：使用 `wx.getStorageSync` / `wx.setStorageSync`。
- Web 原型：使用 `localStorage`。

### 6.1 AppState

```ts
type AppState = {
  settings: Settings
  categories: string[]
  selectedCategory: string
  items: Item[]
  records: RecordLog[]
}
```

### 6.2 Settings

```ts
type Settings = {
  familyName: string
  peopleCount: number
  defaultDeliveryDays: number
  defaultBufferDays: number
}
```

### 6.3 Item

```ts
type Item = {
  id: string
  name: string
  category: string
  unit: string
  stock: number
  dailyUse: number
  deliveryDays: number
  bufferDays: number
  alertDays: number
  defaultBuyQty: number
  link?: string
  note?: string
  createdAt: number
  updatedAt: number
}
```

### 6.4 RecordLog

```ts
type RecordLog = {
  id: string
  type: "add" | "edit" | "delete" | "buy" | "stock" | "postpone" | "category" | "settings"
  title: string
  desc: string
  relatedItemId?: string
  relatedCategory?: string
  createdAt: number
}
```

---

## 7. 默认演示数据

首次打开时初始化以下大类：

```ts
[
  "全部",
  "卫生间",
  "厨房",
  "洗衣清洁",
  "个人护理",
  "客厅/卧室",
  "食品饮品",
  "宠物用品",
  "设备耗材"
]
```

首次打开时初始化以下商品：

```ts
[
  {
    name: "卷纸",
    category: "卫生间",
    unit: "卷",
    stock: 12,
    dailyUse: 0.35,
    deliveryDays: 3,
    bufferDays: 2,
    alertDays: 5,
    defaultBuyQty: 12
  },
  {
    name: "抽纸",
    category: "客厅/卧室",
    unit: "包",
    stock: 6,
    dailyUse: 0.4,
    deliveryDays: 3,
    bufferDays: 2,
    alertDays: 5,
    defaultBuyQty: 18
  },
  {
    name: "垃圾袋",
    category: "厨房",
    unit: "只",
    stock: 20,
    dailyUse: 2,
    deliveryDays: 3,
    bufferDays: 2,
    alertDays: 5,
    defaultBuyQty: 100
  },
  {
    name: "洗衣凝珠",
    category: "洗衣清洁",
    unit: "颗",
    stock: 18,
    dailyUse: 1,
    deliveryDays: 3,
    bufferDays: 2,
    alertDays: 5,
    defaultBuyQty: 52
  },
  {
    name: "牙膏",
    category: "个人护理",
    unit: "支",
    stock: 1,
    dailyUse: 0.04,
    deliveryDays: 3,
    bufferDays: 4,
    alertDays: 7,
    defaultBuyQty: 2
  },
  {
    name: "猫砂",
    category: "宠物用品",
    unit: "袋",
    stock: 1.5,
    dailyUse: 0.08,
    deliveryDays: 3,
    bufferDays: 3,
    alertDays: 6,
    defaultBuyQty: 2,
    note: "按整袋估算"
  },
  {
    name: "宠物粮",
    category: "宠物用品",
    unit: "kg",
    stock: 3.2,
    dailyUse: 0.12,
    deliveryDays: 3,
    bufferDays: 4,
    alertDays: 7,
    defaultBuyQty: 5,
    note: "按每日克数换算"
  },
  {
    name: "宠物湿巾",
    category: "宠物用品",
    unit: "包",
    stock: 2,
    dailyUse: 0.05,
    deliveryDays: 3,
    bufferDays: 3,
    alertDays: 7,
    defaultBuyQty: 3
  }
]
```

---

## 8. 页面与交互验收标准

### 8.1 首页

- 能看到该买、观察、安全数量。
- 商品按紧急程度排序。
- 点击商品卡片进入商品详情。
- 点击“已买”后库存增加。
- 点击“-1”后库存减少。
- 点击“还够用”后提醒顺延。

### 8.2 商品库

- 左侧展示一级大类。
- 点击一级大类后右侧列表变化。
- “宠物用品”作为默认一级大类展示。
- 右上角有“添加”入口。
- 左侧底部有“+ 大类”。
- 新增一级大类后出现在左侧。
- 搜索框可以搜索商品名和大类名。

### 8.3 商品详情

- 展示商品基础信息和计算结果。
- 当前库存支持 `-` 和 `+`。
- 修改字段后点击保存，列表和首页同步更新。
- 点击删除后，商品从列表中移除。
- 点击历史记录后进入记录页，并筛选该商品相关记录。

### 8.4 添加商品

- 从商品库右上角进入。
- 添加页和详情页字段一致。
- 如果当前在某个大类下，添加商品默认选中该大类。
- 保存后返回商品库，并自动选中新商品所属大类。

### 8.5 记录

- 操作后生成记录。
- 支持清空记录。
- 从商品详情进入时，可以筛选当前商品记录。
- 可返回查看全部记录。

### 8.6 我的

- 展示家庭默认参数。
- 可编辑家庭默认参数。
- 展示一级大类及商品数量。
- 空大类可删除。
- 有商品的大类不可删除，并给出提示。
- 可重置演示数据。

---

## 9. 技术实现建议

### 9.1 第一版建议形态

优先做微信小程序原生版本。

建议目录结构：

```txt
/miniprogram
  /pages
    /home
      index.wxml
      index.wxss
      index.ts
    /library
      index.wxml
      index.wxss
      index.ts
    /detail
      index.wxml
      index.wxss
      index.ts
    /add
      index.wxml
      index.wxss
      index.ts
    /records
      index.wxml
      index.wxss
      index.ts
    /profile
      index.wxml
      index.wxss
      index.ts
  /utils
    storage.ts
    calc.ts
    seed.ts
    types.ts
  app.ts
  app.json
  app.wxss
```

### 9.2 页面配置

底部 tabBar：

```json
{
  "list": [
    { "pagePath": "pages/home/index", "text": "首页" },
    { "pagePath": "pages/library/index", "text": "商品库" },
    { "pagePath": "pages/records/index", "text": "记录" },
    { "pagePath": "pages/profile/index", "text": "我的" }
  ]
}
```

添加页不放入 tabBar。

### 9.3 本地存储

建议使用一个统一 key：

```ts
const STORAGE_KEY = "household_consumables_mvp_v1"
```

存储结构：

```ts
type AppState = {
  settings: Settings
  categories: string[]
  items: Item[]
  records: RecordLog[]
}
```

## UI 要求

整体视觉参考产品线框图：

- 黑白灰为主。
- 卡片圆角。
- 商品库左侧分类固定。
- 右侧列表高密度展示。
- 表单紧凑。
- 当前库存支持 `-` 和 `+`。
- 状态用标签区分：该买了、观察、安全。
- 不要上复杂动效。

## 输出要求

开发完成后请提供：

1. 完整代码。
2. 说明如何在微信开发者工具中打开。
3. 核心页面截图或运行说明。
4. 自测结果，至少包含：
   - 新增一个宠物用品商品。
   - 新增一个一级大类。
   - 点击已买后库存增加。
   - 点击还够用后提醒顺延。
   - 删除空大类。
   - 有商品的大类无法删除。
