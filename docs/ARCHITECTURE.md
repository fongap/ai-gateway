# 架构说明

```text
OpenAI / Anthropic Client
           |
           v
   Smart Edge Gateway
           |
     Primary Pool
  health / window / concurrency
           |
       all failed
           v
  Fallback Primary
           |
        failed
           v
 Fallback Secondary (optional)
```

## Primary

Primary 端点参与日常调度。选择时综合：

- 冷却状态
- 健康分
- 滑动窗口请求量
- 当前并发
- 平滑延迟

## Fallback

Fallback 不参与正常轮询。只有 Primary 尝试耗尽后才执行：

1. 第一兜底；
2. 第一兜底失败后，再执行可选第二兜底。

## 状态边界

端点健康分、并发、窗口计数和冷却保存在当前 isolate 内存中，因此属于局部近似状态。它们适合故障规避，不适合作为精确的全球计费或审计数据。

## 协议桥接

Anthropic Messages 请求会被转换为 OpenAI Chat Completions 请求；响应再转换回 Anthropic 格式。网关支持文本、图片、工具调用、流式事件和部分 reasoning/thinking 兼容，但无法凭空补齐上游未提供的语义。
