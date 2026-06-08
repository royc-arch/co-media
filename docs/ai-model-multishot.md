# AI Model + Multi-Shot Video Feature

## 概述

独立功能模块：为商家/用户生成AI模特，并基于该模特生成多个镜头的一致性视频。

**核心要求：**
- 不同 shot 之间，主角外貌保持一致
- 不同 shot 之间，背景保持一致
- UGC / 社交媒体质感（非商业打光风格）

---

## 技术方案

### Stage 1：AI模特生成（图像）

**工具：FLUX Pro 1.1 via fal.ai**
- 价格：~$0.04/张
- 质量：人物细节最接近商业摄影
- 分别生成：模特图（人物 reference）+ 背景图（场景 reference）

### Stage 2：背景合成

**工具：sharp（已有）**
- 将模特抠图合成到背景图
- 每个 shot 用同一合成帧作为起始帧 → 确保背景100%一致

### Stage 3：多 Shot 视频生成

**工具：Hailuo (MiniMax) via fal.ai**
- 价格：~$0.10/段
- 人物面部/外貌一致性：目前市面最强
- 输入：合成帧 + character_reference（锁定人物）
- 每个 shot 使用不同 camera motion prompt

### Stage 4：（可选）视频拼接

**工具：ffmpeg-static（已有）**
- crossfade 拼接多段视频

---

## Shot 类型设计

| Shot | 描述 |
|---|---|
| `full_body` | 全身，自然站姿，轻微呼吸感 |
| `close_face` | 面部特写，眼神互动 |
| `walk_toward` | 模特走向镜头 |
| `turn_around` | 转身展示背面 |
| `sit_relax` | 坐下，生活化姿态 |

---

## 成本估算（一套5个shot）

| 步骤 | 工具 | 费用 |
|---|---|---|
| 模特图 + 背景图 | FLUX Pro × 2 | $0.08 |
| 5段视频 | Hailuo × 5 | $0.50 |
| **合计** | | **~$0.58/套** |

---

## 备选模型对比

| 模型 | 人物一致性 | 背景一致性 | API | 价格/段 |
|---|---|---|---|---|
| **Hailuo (MiniMax)** ✅ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | fal.ai | ~$0.10 |
| Kling v3（已有） | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 已集成 | ~$0.20 |
| Vidu 2.0 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 官方API | ~$0.15 |
| Seedance 2.0 | ⭐⭐⭐⭐ | ⭐⭐⭐ | Higgsfield $199/月 | 未知 |

---

## 关键工程决策

**背景一致性的实现方式：**
不依赖模型"记住"背景，而是将同一张背景图作为所有 shot 的合成起始帧。
这是目前最稳定可控的工程解法。

---

## 实现顺序（待开发）

1. [ ] FLUX Pro 模特生成 API 接入
2. [ ] 背景生成 + sharp 合成
3. [ ] Hailuo fal.ai 接入
4. [ ] 多 shot 并行生成逻辑
5. [ ] ffmpeg 拼接（复用 showcase 已有逻辑）
6. [ ] 前端 UI
