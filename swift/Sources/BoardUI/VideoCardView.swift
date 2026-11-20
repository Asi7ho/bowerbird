import AppKit
import AVFoundation
import AVKit
import BowerbirdCore

/// A video card, like the Electron app's: a poster until
/// it is played. A live player per card would cost a
/// decoder and a composited frame on every pan, and a
/// board of videos grinds — so the card shows the
/// captured poster (or a dark tile with a play button
/// when there is none), and the player mounts only for
/// the card whose play button was pressed. Remote links
/// (YouTube, Vimeo, …) show as a link tile, as before.
public final class VideoCardView: CardView {
    private let posterView = NSImageView()
    private let tileLayer = CALayer()
    private let playButton = NSButton()
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()
    /// The player, mounted only while this card is
    /// playing (nil the rest of the time).
    private var playerView: AVPlayerView?
    /// The video this view is showing, so a reconfigure
    /// for the same card does not rebuild the poster or
    /// tear down a playing video.
    private var currentSource: String?
    private var currentRemote = false

    override public init() {
        super.init()
        posterView.imageScaling = .scaleProportionallyUpOrDown
        posterView.wantsLayer = true
        posterView.layer?.masksToBounds = true
        addSubview(posterView)
        tileLayer.backgroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        layer?.addSublayer(tileLayer)
        playButton.image = NSImage(systemSymbolName: "play.circle.fill", accessibilityDescription: "Play video")
        playButton.imageScaling = .scaleProportionallyUpOrDown
        playButton.isBordered = false
        playButton.contentTintColor = .white
        playButton.target = self
        playButton.action = #selector(playTapped)
        addSubview(playButton)
        titleLayer.foregroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        subtitleLayer.foregroundColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.44, alpha: 1).cgColor
        titleLayer.truncationMode = .end
        subtitleLayer.truncationMode = .end
        for textLayer in [titleLayer, subtitleLayer] {
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            layer?.addSublayer(textLayer)
        }
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .video(let video) = item.kind else { return }
        titleLayer.string = video.remote
            ? (URL(string: video.source)?.host ?? video.source)
            : URL(fileURLWithPath: video.source).lastPathComponent
        let kb = Int((Double(video.sizeBytes) / 1024).rounded())
        var sub = video.remote ? "Video link" : "\(kb) KB"
        if let duration = video.duration, duration > 0 {
            sub += " · \(Self.formatTime(duration))"
        }
        subtitleLayer.string = sub
        if video.source != currentSource || video.remote != currentRemote {
            tearDownPlayer()
            currentSource = video.source
            currentRemote = video.remote
            posterView.image = video.poster.flatMap { NSImage(contentsOfFile: $0) }
        }
        let playing = playerView != nil
        posterView.isHidden = playing
        playButton.isHidden = playing || video.remote
        tileLayer.isHidden = playing || posterView.image != nil
        layer?.backgroundColor = NSColor.white.cgColor
        needsLayout = true
    }

    /// The play button is a borderless image-only button
    /// whose frame is set in layout, and NSButton's own
    /// hitTest returns nil for such a button (its own
    /// centre misses, even visible and enabled) — the
    /// same quirk as the audio card's play button. Check
    /// the frame directly so the button stays clickable.
    override public func hitTest(_ point: NSPoint) -> NSView? {
        if !playButton.isHidden, playButton.frame.contains(point) { return playButton }
        return super.hitTest(point)
    }

    @objc private func playTapped() {
        guard playerView == nil,
              let source = currentSource, !currentRemote else { return }
        let playerView = AVPlayerView()
        playerView.player = AVPlayer(url: URL(fileURLWithPath: source))
        playerView.controlsStyle = .inline
        playerView.wantsLayer = true
        playerView.layer?.masksToBounds = true
        addSubview(playerView)
        self.playerView = playerView
        posterView.isHidden = true
        playButton.isHidden = true
        tileLayer.isHidden = true
        needsLayout = true
        playerView.player?.play()
    }

    /// Stops the player and removes its view, so a
    /// recycled card never keeps another card's video.
    private func tearDownPlayer() {
        playerView?.player?.pause()
        playerView?.removeFromSuperview()
        playerView = nil
    }

    override public func layout() {
        super.layout()
        // Media-card chrome: 12px padding, 10px preview
        // radius, title 14px, subtitle 12px — all in
        // world units, scaled by the zoom. The card is
        // y-up, so the top is at bounds.height: the poster
        // (or the dark tile) sits at the top, the title and
        // subtitle below it, the play button centred on
        // the poster.
        guard let item = currentItem, case .video = item.kind else { return }
        CardView.withoutLayerActions {
            let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
            let pad = 12 * zoom
            let width = bounds.width - pad * 2
            titleLayer.font = NSFont.systemFont(ofSize: 14 * zoom, weight: .semibold)
            titleLayer.fontSize = 14 * zoom
            subtitleLayer.font = NSFont.systemFont(ofSize: 12 * zoom)
            subtitleLayer.fontSize = 12 * zoom
            let titleH: CGFloat = 18 * zoom
            let subH: CGFloat = 16 * zoom
            let gap: CGFloat = 4 * zoom
            let textH = titleH + gap + subH
            let mediaH = bounds.height - pad * 2 - textH - gap
            let mediaRect = CGRect(x: pad, y: bounds.height - pad - mediaH, width: width, height: max(mediaH, 0))
            posterView.frame = mediaRect
            posterView.layer?.cornerRadius = 10 * zoom
            tileLayer.frame = mediaRect
            tileLayer.cornerRadius = 10 * zoom
            let playSize: CGFloat = 56 * zoom
            playButton.frame = CGRect(
                x: mediaRect.midX - playSize / 2,
                y: mediaRect.midY - playSize / 2,
                width: playSize, height: playSize
            )
            playerView?.frame = mediaRect
            playerView?.layer?.cornerRadius = 10 * zoom
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH, width: width, height: titleH)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH - gap - subH, width: width, height: subH)
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
        fatalError("VideoCardView is not Interface Builder backed")
    }
}
