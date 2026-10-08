// Renders a synthetic WeChat-like scene (JSON) to a PNG, so the recogniser
// can be tested on images that contain no real person.
//
//   render SCENE.json OUT.png
//
// Scene: { "width", "height" (points), "scale", "background": "#rrggbb",
//          "rects": [{ "x","y","w","h","color","radius"? }],
//          "texts": [{ "text","x","y","size","color","bold"? }] }   x, y = top-left in points.
import AppKit
import ImageIO

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

func color(_ hex: String) -> NSColor {
    var s = hex
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { fail("bad colour \(hex)") }
    return NSColor(deviceRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

let args = CommandLine.arguments
guard args.count == 3, let data = FileManager.default.contents(atPath: args[1]),
      let scene = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
else { fail("usage: render SCENE.json OUT.png") }

let width = scene["width"] as? Double ?? 1280, height = scene["height"] as? Double ?? 875
let scale = scene["scale"] as? Double ?? 2
let rects = scene["rects"] as? [[String: Any]] ?? []
let texts = scene["texts"] as? [[String: Any]] ?? []

let pixelsWide = Int(width * scale), pixelsHigh = Int(height * scale)
guard let cg = CGContext(data: nil, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8, bytesPerRow: 0,
                         space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { fail("cannot allocate bitmap") }
// Top-left origin in points: flip the y axis and scale points to pixels.
cg.translateBy(x: 0, y: CGFloat(pixelsHigh))
cg.scaleBy(x: scale, y: -scale)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

color(scene["background"] as? String ?? "#1C1C1E").setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
for r in rects {
    let rect = NSRect(x: r["x"] as? Double ?? 0, y: r["y"] as? Double ?? 0, width: r["w"] as? Double ?? 0, height: r["h"] as? Double ?? 0)
    color(r["color"] as? String ?? "#000000").setFill()
    let radius = r["radius"] as? Double ?? 0
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}
for t in texts {
    let size = t["size"] as? Double ?? 14
    let bold = t["bold"] as? Bool ?? false
    let font = NSFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color(t["color"] as? String ?? "#E5E5E5")]
    NSAttributedString(string: t["text"] as? String ?? "", attributes: attributes)
        .draw(at: NSPoint(x: t["x"] as? Double ?? 0, y: t["y"] as? Double ?? 0))
}
NSGraphicsContext.restoreGraphicsState()
guard let made = cg.makeImage(),
      let sink = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, "public.png" as CFString, 1, nil)
else { fail("cannot encode PNG") }
CGImageDestinationAddImage(sink, made, nil)
guard CGImageDestinationFinalize(sink) else { fail("cannot write \(args[2])") }
