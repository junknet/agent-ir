/**
 * protobuf 类型的**运行时反射**加载 —— 不做 codegen。
 *
 * Windsurf 的 `exa.*` 有 57 个 proto 文件、300+ 消息类型，而这个出口真正碰到的只有 8 个。
 * 全量 codegen 会把几万行生成代码塞进一个「core 必须零依赖」的仓库，且每次上游加字段
 * 都要重新生成。改用 `FileDescriptorSet`（`windsurf_exa.fds.pb`，588KB，从生产实现原样拷来）
 * 在运行时建注册表，按全限定名取 `DescMessage`，再 `create` / `toBinary` / `fromBinary`。
 *
 * 代价是类型安全从编译期挪到运行时：字段名写错不会红，会在 `create` 时抛
 * 「no such field」。缓解办法是把**全部**类型名与字段名收敛到本文件的常量里
 * （`WINDSURF_TYPES`），拼错只会拼错一次，且有一条测试逐个取一遍。
 *
 * `@bufbuild/protobuf` 是这个子目录**唯一**允许的运行时依赖（package.json 的
 * optionalDependencies）。core 与其余四个出口继续零依赖。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFileRegistry, fromBinary, type DescMessage, type Registry,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

/** 本出口用到的全部 protobuf 类型。唯一授权的一份名字表。 */
export const WINDSURF_TYPES = {
  request: "exa.api_server_pb.GetChatMessageRequest",
  response: "exa.api_server_pb.GetChatMessageResponse",
  toolCall: "exa.codeium_common_pb.ChatToolCall",
  image: "exa.codeium_common_pb.ImageData",
} as const;

export function defaultFdsPath(): string {
  return fileURLToPath(new URL("./windsurf_exa.fds.pb", import.meta.url));
}

/**
 * `exa.*` 的运行时类型注册表。
 *
 * 子消息 descriptor 一律从**父字段**上取（`childOf`），不按名字二次查表：
 * `GetChatMessageRequest.configuration` 的类型是什么，只有它自己的字段说了算。
 * 按名字查表等于在这里维护第二份「哪个字段是哪个类型」的认知，上游改字段类型时
 * 它不会报错，只会把消息编成另一个类型的字节。
 */
export class WindsurfSchema {
  readonly #registry: Registry;
  readonly requestDesc: DescMessage;
  readonly responseDesc: DescMessage;

  constructor(fdsPath: string = defaultFdsPath()) {
    const raw = readFileSync(fdsPath);
    const set = fromBinary(FileDescriptorSetSchema, new Uint8Array(raw));
    this.#registry = createFileRegistry(set);
    this.requestDesc = this.message(WINDSURF_TYPES.request);
    this.responseDesc = this.message(WINDSURF_TYPES.response);
  }

  message(typeName: string): DescMessage {
    const desc = this.#registry.getMessage(typeName);
    if (desc === undefined) {
      throw new Error(`windsurf schema is missing message type '${typeName}'`);
    }
    return desc;
  }

  /** 取某个消息字段的子消息 descriptor。字段名或类型不对时立刻抛，不静默降级。 */
  childOf(parent: DescMessage, fieldName: string): DescMessage {
    const field = parent.fields.find((one) => one.localName === fieldName || one.name === fieldName);
    if (field === undefined) {
      throw new Error(`windsurf schema: ${parent.typeName} has no field '${fieldName}'`);
    }
    const child = (field as { message?: DescMessage }).message;
    if (child === undefined) {
      throw new Error(`windsurf schema: ${parent.typeName}.${fieldName} is not a message field`);
    }
    return child;
  }
}

/**
 * 588KB 的 FileDescriptorSet 过一遍 `createFileRegistry` 是重构造（实测数十毫秒）。
 * 每次 `createWindsurfUpstream` 重建一次会在网关热路径上白烧 CPU，
 * 而 descriptor 是只读闭包，天然可共享。按路径缓存，不同 fds 各一份。
 */
const sharedByPath = new Map<string, WindsurfSchema>();

export function getSharedWindsurfSchema(fdsPath: string = defaultFdsPath()): WindsurfSchema {
  const cached = sharedByPath.get(fdsPath);
  if (cached !== undefined) return cached;
  const schema = new WindsurfSchema(fdsPath);
  sharedByPath.set(fdsPath, schema);
  return schema;
}
