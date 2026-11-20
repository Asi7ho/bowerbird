import AppKit
import AVFoundation
import BowerbirdCore

/// An audio card, like the Electron app's: a tile with a
/// play button and a seek track, the title and the time as
/// a quiet grey line below it. The sound is a real
/// AVPlayer, so the card plays; a missing file shows its
/// name with "File missing" instead of controls. (A voice
/// note's transcript toggle is not in this pass — the
/// welcome birdsong has none — it follows with the
/// transcript UI.)
public final class AudioCardView: CardView {
    private let tileLayer = CALayer()
    private let playButton = NSButton()
    private let titleLayer = CATextLayer()
    private let timeLayer = CATextLayer()
    /// The seek track is drawn, not an NSSlider: AppKit
    /// draws a slider's track and knob at a fixed size
    /// whatever its frame, so at low zoom the slider
    /// stayed chunky while the rest of the card shrank.
    /// These three layers scale with the zoom like
    /// everything else on the card.
    private let trackLayer = CALayer()
    private let fillLayer = CALayer()
    private let thumbLayer = CALayer()
    /// The seek position as a fraction of the track,
    /// 0...1; the layers are placed from it in layout().
    private var seekFraction: CGFloat = 0
    /// The track's frame, and the taller hit area around
    /// it (about 6 world pixels above and below), so the
    /// track stays clickable at low zoom.
    private var trackFrame = CGRect.zero
    private var seekHitRect = CGRect.zero
    /// Whether the user is dragging the thumb; while
    /// true the time observer leaves the fraction alone.
    private var seeking = false
    /// The player for this card's file (nil when the file
    /// is missing, or before the first configure).
    private var player: AVPlayer?
    /// The time observer's token, so it is removed when
    /// the card is recycled for another file.
    private var timeObserver: Any?
    /// Whether the player is playing (the button shows
    /// the other state).
    private var isPlaying = false
    /// The file this view is showing, so a reconfigure
    /// for the same card does not rebuild the player.
    private var currentPath: String?

    override public init() {
        super.init()
        tileLayer.backgroundColor = NSColor.systemGray.withAlphaComponent(0.08).cgColor
        layer?.addSublayer(tileLayer)
        playButton.image = NSImage(systemSymbolName: "play.fill", accessibilityDescription: "Play audio")
        playButton.isBordered = false
        // The symbol scales with the button's frame, so
        // it shrinks with the card instead of staying at
        // its fixed size (the same setting the video
        // card's play button already has).
        playButton.imageScaling = .scaleProportionallyUpOrDown
        playButton.contentTintColor = NSColor.fromHex("#6A4C93") ?? .labelColor
        playButton.target = self
        playButton.action = #selector(playTapped)
        addSubview(playButton)
        trackLayer.backgroundColor = NSColor.systemGray.withAlphaComponent(0.35).cgColor
        fillLayer.backgroundColor = (NSColor.fromHex("#6A4C93") ?? .systemPurple).cgColor
        thumbLayer.backgroundColor = NSColor.white.cgColor
        thumbLayer.borderColor = NSColor.systemGray.withAlphaComponent(0.5).cgColor
        for seekLayer in [trackLayer, fillLayer, thumbLayer] {
            layer?.addSublayer(seekLayer)
        }
        titleLayer.foregroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        timeLayer.foregroundColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.44, alpha: 1).cgColor
        titleLayer.truncationMode = .end
        timeLayer.truncationMode = .end
        for textLayer in [titleLayer, timeLayer] {
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            layer?.addSublayer(textLayer)
        }
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .audio(let audio) = item.kind else { return }
        titleLayer.string = (audio.title?.isEmpty == false ? audio.title : nil)
            ?? URL(fileURLWithPath: audio.path).lastPathComponent
        if audio.path != currentPath {
            tearDownPlayer()
            currentPath = audio.path
            seekFraction = 0
            updateSeekLayers()
            if FileManager.default.fileExists(atPath: audio.path) {
                let player = AVPlayer(url: URL(fileURLWithPath: audio.path))
                self.player = player
                timeObserver = player.addPeriodicTimeObserver(
                    forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
                    queue: .main
                ) { [weak self] _ in self?.updateTime() }
                if let currentItem = player.currentItem {
                    NotificationCenter.default.addObserver(
                        self,
                        selector: #selector(playerDidFinish),
                        name: .AVPlayerItemDidPlayToEndTime,
                        object: currentItem
                    )
                }
            }
        }
        let missing = player == nil
        playButton.isEnabled = !missing
        for seekLayer in [trackLayer, fillLayer, thumbLayer] {
            seekLayer.isHidden = missing
        }
        playButton.image = NSImage(
            systemSymbolName: isPlaying ? "pause.fill" : "play.fill",
            accessibilityDescription: isPlaying ? "Pause audio" : "Play audio"
        )
        timeLayer.string = missing ? "File missing" : "0:00 / \(Self.formatTime(duration()))"
        layer?.backgroundColor = NSColor.white.cgColor
        needsLayout = true
    }

    @objc private func playTapped() {
        guard let player else { return }
        if isPlaying {
            player.pause()
            isPlaying = false
        } else {
            player.play()
            isPlaying = true
        }
        playButton.image = NSImage(
            systemSymbolName: isPlaying ? "pause.fill" : "play.fill",
            accessibilityDescription: isPlaying ? "Pause audio" : "Play audio"
        )
    }

    /// Seeks to the fraction of the track under `point`
    /// (view coordinates) and moves the thumb there.
    private func seek(to point: CGPoint) {
        guard let player, trackFrame.width > 0 else { return }
        let duration = self.duration()
        guard duration > 0 else { return }
        seekFraction = min(1, max(0, (point.x - trackFrame.minX) / trackFrame.width))
        player.seek(to: CMTime(seconds: Double(seekFraction) * duration, preferredTimescale: 600))
        updateSeekLayers()
        updateTime()
    }

    /// Places the track, fill and thumb from the stored
    /// fraction and the track frame layout() computed.
    private func updateSeekLayers() {
        guard let item = currentItem else { return }
        let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
        let thumbDiameter: CGFloat = 12 * zoom
        CardView.withoutLayerActions {
            trackLayer.frame = trackFrame
            trackLayer.cornerRadius = trackFrame.height / 2
            let fillWidth = trackFrame.width * seekFraction
            fillLayer.frame = CGRect(x: trackFrame.minX, y: trackFrame.minY, width: fillWidth, height: trackFrame.height)
            fillLayer.cornerRadius = trackFrame.height / 2
            thumbLayer.frame = CGRect(
                x: trackFrame.minX + fillWidth - thumbDiameter / 2,
                y: trackFrame.midY - thumbDiameter / 2,
                width: thumbDiameter,
                height: thumbDiameter
            )
            thumbLayer.cornerRadius = thumbDiameter / 2
            thumbLayer.borderWidth = max(0.5, 1 * zoom)
        }
    }

    /// The seek track is drawn, not a view, so no subview
    /// claims a click on it: the card itself takes it.
    /// Anywhere else the card passes the click through
    /// like any other card (its play button is a subview
    /// and takes its own clicks), so it can still be
    /// selected and dragged.
    override public func hitTest(_ point: NSPoint) -> NSView? {
        if player != nil, seekHitRect.contains(point) { return self }
        return super.hitTest(point)
    }

    /// A click on the seek track starts a seek drag. A
    /// click anywhere else never reaches here: hitTest
    /// passes it through to the viewport.
    override public func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard player != nil, seekHitRect.contains(point) else {
            super.mouseDown(with: event)
            return
        }
        seeking = true
        seek(to: point)
    }

    override public func mouseDragged(with event: NSEvent) {
        guard seeking else {
            super.mouseDragged(with: event)
            return
        }
        seek(to: convert(event.locationInWindow, from: nil))
    }

    override public func mouseUp(with event: NSEvent) {
        if seeking {
            seeking = false
            return
        }
        super.mouseUp(with: event)
    }

    @objc private func playerDidFinish() {
        guard let player else { return }
        isPlaying = false
        player.seek(to: .zero)
        playButton.image = NSImage(systemSymbolName: "play.fill", accessibilityDescription: "Play audio")
        updateTime()
    }

    /// The player's duration in seconds, or 0 when it is
    /// unknown (the file has not loaded yet).
    private func duration() -> Double {
        guard let duration = player?.currentItem?.duration else { return 0 }
        let seconds = CMTimeGetSeconds(duration)
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    /// Refreshes the time line and the seek position from
    /// the player. The thumb is left alone while the user
    /// is dragging it, so it does not fight their hand.
    private func updateTime() {
        guard let player else { return }
        let total = duration()
        let current = CMTimeGetSeconds(player.currentTime())
        let currentSeconds = current.isFinite && current > 0 ? current : 0
        timeLayer.string = "\(Self.formatTime(currentSeconds)) / \(Self.formatTime(total))"
        if !seeking, total > 0 {
            seekFraction = CGFloat(currentSeconds / total)
            updateSeekLayers()
        }
    }

    /// Stops the player and removes its observers, so a
    /// recycled card never keeps another card's sound or
    /// its time updates.
    private func tearDownPlayer() {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: player?.currentItem)
        player?.pause()
        player = nil
        isPlaying = false
    }

    deinit {
        tearDownPlayer()
    }

    override public func layout() {
        super.layout()
        // Like the other media cards: 12px padding, 10px
        // tile radius, title 14px, time 12px — all in
        // world units, scaled by the zoom. The card is
        // y-up, so the top is at bounds.height: the player
        // tile sits at the top, the title and time below
        // it. The tile is 56px tall on a card 104px or
        // taller, 48px on a shorter one (the Electron
        // app's audio tile).
        guard let item = currentItem, case .audio = item.kind else { return }
        CardView.withoutLayerActions {
            let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
            let pad = 12 * zoom
            let width = bounds.width - pad * 2
            titleLayer.font = NSFont.systemFont(ofSize: 14 * zoom, weight: .semibold)
            titleLayer.fontSize = 14 * zoom
            timeLayer.font = NSFont.systemFont(ofSize: 12 * zoom)
            timeLayer.fontSize = 12 * zoom
            let worldH = item.size.h
            let tileH: CGFloat = (worldH >= 104 ? 56 : 48) * zoom
            let titleH: CGFloat = 18 * zoom
            let subH: CGFloat = 16 * zoom
            let gap: CGFloat = 4 * zoom
            let tileRect = CGRect(x: pad, y: bounds.height - pad - tileH, width: width, height: tileH)
            tileLayer.frame = tileRect
            tileLayer.cornerRadius = 10 * zoom
            let buttonSize: CGFloat = 32 * zoom
            playButton.frame = CGRect(x: tileRect.minX + 8 * zoom, y: tileRect.midY - buttonSize / 2, width: buttonSize, height: buttonSize)
            // The track is 4 world pixels tall, centred
            // in the tile; its hit area extends 6 world
            // pixels above and below so it stays
            // clickable when zoomed out.
            let trackX = tileRect.minX + 8 * zoom + buttonSize + 8 * zoom
            let trackWidth = tileRect.width - (8 * zoom + buttonSize + 8 * zoom) - 8 * zoom
            trackFrame = CGRect(x: trackX, y: tileRect.midY - 2 * zoom, width: trackWidth, height: 4 * zoom)
            seekHitRect = trackFrame.insetBy(dx: 0, dy: -6 * zoom)
            updateSeekLayers()
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - tileH - gap - titleH, width: width, height: titleH)
            timeLayer.frame = CGRect(x: pad, y: bounds.height - pad - tileH - gap - titleH - gap - subH, width: width, height: subH)
        }
    }

    /// A duration as m:ss (the Electron app's
    /// `formatAudioTime`).
    private static func formatTime(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("AudioCardView is not Interface Builder backed")
    }
}
