# Relay V3 协议契约

自托管 relay（`relay-server/`）与全部客户端（桌面 device transport、手机 terminal、
桌面控制端、source-server daemon）共享的 V3 协议模块。V3 是全新协议，不兼容闭源
Relay V2，不保留 V2 字段兼容层。

职责边界：

- 本模块只承载契约（类型、严格解析、端点常量）、信封编解码、端到端加密与心跳时序，
  不含任何网络 IO 与状态机；transport 状态机在各端实现。
- relay 只负责认证、设备目录、配对与密文透传；task/workspace/stream/已提交输入等
  业务状态不属于 relay（§1 非目标）。
- 端到端加密：X25519 static-static ECDH + HKDF-SHA256（公钥排序对称化）+
  AES-256-GCM；密钥生成、派生、加解密全部在各端完成，relay 进程不引入加密依赖。
  私钥永不出端，不进日志、不进设置同步。
- `data.payload` 对 relay 为不透明字符串：relay 只校验其为合法 JSON 对象且长度在
  预算内；严格信封校验（`parseRelayV3Envelope`）由接收端在解密边界执行。
- WS 配对 owner 语义由 relay 进程内存唯一持有：同角色后到者替换旧 owner（device
  侧旧连接收 `KICKED`；terminal 侧旧连接收 `waiting` 并被关闭——单 active
  terminal），旧连接异步 close 不得移除新 owner。
- 时间戳为非负整数 Unix 秒，不参与授权；错误码仅
  `AUTH_FAILED | WRONG_PARAM | KICKED | INTERNAL | DEVICE_OFFLINE`。

协议与验收见 [Relay V3 自托管设计与架构](../../../../docs/relay-server/relay-v3-design.md)；
测试接缝（真实 loopback HTTP/WS、故障注入、消息留存）见
`packages/shared/test/fixtures/fake-relay-v3.ts`，fixture 与真实 relay 共用一致性矩阵。
