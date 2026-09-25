// The two framings the hub's realtime namespaces speak over one WebSocket
// (packages/contracts/events/README.md): Engine.IO v4 packets carry Socket.IO v5 packets.
// Pure encode/decode, so the protocol is unit-tested without a socket (EngineIOTests).
import Foundation

/// An Engine.IO v4 text packet: one digit, then its data.
enum EngineIOPacket: Equatable {
    case open(String)
    case close
    case ping(String)
    case pong(String)
    case message(String)
    case upgrade
    case noop

    static func decode(_ text: String) -> EngineIOPacket? {
        guard let first = text.first else { return nil }
        let rest = String(text.dropFirst())
        switch first {
        case "0": return .open(rest)
        case "1": return .close
        case "2": return .ping(rest)
        case "3": return .pong(rest)
        case "4": return .message(rest)
        case "5": return .upgrade
        case "6": return .noop
        default: return nil
        }
    }

    var encoded: String {
        switch self {
        case .open(let data): return "0" + data
        case .close: return "1"
        case .ping(let data): return "2" + data
        case .pong(let data): return "3" + data
        case .message(let data): return "4" + data
        case .upgrade: return "5"
        case .noop: return "6"
        }
    }
}

/// What the hub says in the Engine.IO `open` packet.
struct EngineIOHandshake: Decodable, Equatable {
    let sid: String
    let pingInterval: Int
    let pingTimeout: Int
}

/// A Socket.IO v5 packet inside an Engine.IO `message`. `payload` is the raw JSON text.
struct SocketIOPacket: Equatable {
    enum Kind: Int {
        case connect = 0
        case disconnect = 1
        case event = 2
        case ack = 3
        case connectError = 4
        case binaryEvent = 5
        case binaryAck = 6
    }

    var kind: Kind
    var namespace: String
    var id: Int?
    var payload: String?

    init(kind: Kind, namespace: String = "/", id: Int? = nil, payload: String? = nil) {
        self.kind = kind
        self.namespace = namespace
        self.id = id
        self.payload = payload
    }

    static func decode(_ text: String) -> SocketIOPacket? {
        var chars = Substring(text)
        guard let first = chars.first, let digit = first.wholeNumberValue,
              let kind = Kind(rawValue: digit) else { return nil }
        chars = chars.dropFirst()
        // Binary packets announce their attachment count (`51-`); the hub sends none.
        if kind == .binaryEvent || kind == .binaryAck {
            guard let dash = chars.firstIndex(of: "-") else { return nil }
            chars = chars[chars.index(after: dash)...]
        }
        var namespace = "/"
        if chars.first == "/" {
            if let comma = chars.firstIndex(of: ",") {
                namespace = String(chars[..<comma])
                chars = chars[chars.index(after: comma)...]
            } else {
                namespace = String(chars)
                chars = ""
            }
        }
        var digits = ""
        while let c = chars.first, c.isASCII, c.isNumber {
            digits.append(c)
            chars = chars.dropFirst()
        }
        let payload = chars.isEmpty ? nil : String(chars)
        return SocketIOPacket(kind: kind, namespace: namespace, id: Int(digits), payload: payload)
    }

    var encoded: String {
        var out = String(kind.rawValue)
        if namespace != "/" { out += namespace + "," }
        if let id { out += String(id) }
        if let payload { out += payload }
        return out
    }

    /// `["name", {…}]` for an event; `nil` data sends the name alone.
    static func event(_ name: String, data: Any?, namespace: String, id: Int? = nil) -> SocketIOPacket {
        var array: [Any] = [name]
        if let data { array.append(data) }
        return SocketIOPacket(kind: .event, namespace: namespace, id: id, payload: JSON.text(array))
    }

    /// The event name and its first argument as JSON data, for an `event` packet.
    var eventContent: (name: String, argument: Data?)? {
        guard kind == .event, let payload,
              let array = JSON.object(payload) as? [Any],
              let name = array.first as? String else { return nil }
        let argument = array.count > 1 ? JSON.data(array[1]) : nil
        return (name, argument)
    }

    /// The first argument of an `ack` packet as JSON data.
    var ackArgument: Data? {
        guard kind == .ack, let payload, let array = JSON.object(payload) as? [Any],
              let first = array.first else { return nil }
        return JSON.data(first)
    }

    /// `{ message, data: { code } }` of a refused namespace connection.
    var connectErrorCode: String? {
        guard kind == .connectError, let payload,
              let object = JSON.object(payload) as? [String: Any] else { return nil }
        if let data = object["data"] as? [String: Any], let code = data["code"] as? String {
            return code
        }
        return object["message"] as? String
    }
}

/// Small JSONSerialization helpers shared by the realtime code.
enum JSON {
    static func object(_ text: String) -> Any? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func data(_ value: Any) -> Data? {
        if value is NSNull { return "null".data(using: .utf8) }
        return try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    }

    static func text(_ value: Any) -> String? {
        guard let data = data(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
