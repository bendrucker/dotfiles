import Foundation

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: watch-theme-change.swift <bin-dir>\n".utf8))
    exit(1)
}

let binDir = CommandLine.arguments[1]

DistributedNotificationCenter.default().addObserver(
    forName: .init("AppleInterfaceThemeChangedNotification"),
    object: nil,
    queue: .main
) { _ in
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "\(binDir)/theme-sync")
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        FileHandle.standardError.write(
            Data("watch-theme-change: failed to run theme-sync: \(error)\n".utf8)
        )
    }
}

RunLoop.main.run()
