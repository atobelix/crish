# M5 · `query_blocks` 工具 schema（W2-F 提前设计）

## 工具名

`query_blocks`

## 入参（JSON Schema 草案）

```json
{
  "type": "object",
  "properties": {
    "doc_id": { "type": "string" },
    "kind_in": { "type": "array", "items": { "type": "string" } },
    "attrs_eq": {
      "type": "object",
      "additionalProperties": true,
      "description": "属性等值组合（白名单键）"
    },
    "text_match": { "type": "string", "description": "FTS 子串/短语" },
    "ref_to": { "type": "string", "description": "引用目标 block_id" },
    "ref_from": { "type": "string" },
    "limit": { "type": "integer", "maximum": 200, "default": 50 }
  },
  "required": ["doc_id"]
}
```

## 出参

`{ "blocks": [ { "id", "kind", "snippet", "attrs" } ], "truncated": false }`

## 禁止

- 任意 SQL 字符串（可另开 `query_sql` 且默认 Deny + 强审批）
- 绕过索引全表扫默认路径

## 验收

A-QRY-01：属性组合 + refs + fulltext 与 三路至少一测。
