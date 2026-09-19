import SwiftUI
import WebKit

public struct ProgressUpdate: Equatable {
    public let position: Double
    public let duration: Double
    public let completed: Bool
    public let id: UUID
    
    public init(position: Double, duration: Double, completed: Bool) {
        self.position = position
        self.duration = duration
        self.completed = completed
        self.id = UUID()
    }
}

/// SwiftUI wrapper around WKWebView with full cookie persistence, pull-to-refresh,
/// navigation tracking, and native JavaScript bridge support for Vault Streaming.
public struct WebViewWrapper: UIViewRepresentable {
    let url: URL
    @Binding var isLoading: Bool
    @Binding var navigationError: String?
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var activeStream: StreamPlaybackItem?
    @Binding var progressUpdate: ProgressUpdate?
    
    // Actions triggered from parent view
    var reloadToken: Int
    var goBackToken: Int
    var goForwardToken: Int
    
    public init(
        url: URL,
        isLoading: Binding<Bool>,
        navigationError: Binding<String?>,
        canGoBack: Binding<Bool>,
        canGoForward: Binding<Bool>,
        activeStream: Binding<StreamPlaybackItem?> = .constant(nil),
        progressUpdate: Binding<ProgressUpdate?> = .constant(nil),
        reloadToken: Int = 0,
        goBackToken: Int = 0,
        goForwardToken: Int = 0
    ) {
        self.url = url
        self._isLoading = isLoading
        self._navigationError = navigationError
        self._canGoBack = canGoBack
        self._canGoForward = canGoForward
        self._activeStream = activeStream
        self._progressUpdate = progressUpdate
        self.reloadToken = reloadToken
        self.goBackToken = goBackToken
        self.goForwardToken = goForwardToken
    }
    
    public func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    public func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        
        // Use default persistent data store to keep cookies, localStorage, and IndexedDB
        // across app restarts (preventing iOS Safari 7-day storage eviction).
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        
        // Mobile streaming configurations
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        
        // Register JavaScript bridge handler
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "vaultStreamingBridge")
        configuration.userContentController = contentController
        
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.customUserAgent = AppConfig.customUserAgent
        webView.allowsBackForwardNavigationGestures = true
        webView.backgroundColor = UIColor(red: 11/255.0, green: 8/255.0, blue: 19/255.0, alpha: 1.0)
        webView.isOpaque = false
        webView.scrollView.backgroundColor = UIColor(red: 11/255.0, green: 8/255.0, blue: 19/255.0, alpha: 1.0)
        
        // Add native pull-to-refresh
        let refreshControl = UIRefreshControl()
        refreshControl.tintColor = UIColor(red: 176/255.0, green: 124/255.0, blue: 255/255.0, alpha: 1.0)
        refreshControl.addTarget(context.coordinator, action: #selector(Coordinator.handleRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
        
        context.coordinator.webView = webView
        context.coordinator.currentURL = url
        
        // Load initial URL
        let request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30)
        webView.load(request)
        
        return webView
    }
    
    public func updateUIView(_ uiView: WKWebView, context: Context) {
        // Dynamically load new URL if changed in settings
        if context.coordinator.currentURL != url {
            context.coordinator.currentURL = url
            let request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30)
            uiView.load(request)
        }

        if goBackToken != context.coordinator.lastHandledGoBackToken {
            context.coordinator.lastHandledGoBackToken = goBackToken
            if uiView.canGoBack {
                uiView.goBack()
            }
        }
        if goForwardToken != context.coordinator.lastHandledGoForwardToken {
            context.coordinator.lastHandledGoForwardToken = goForwardToken
            if uiView.canGoForward {
                uiView.goForward()
            }
        }
        if reloadToken != context.coordinator.lastHandledReloadToken {
            context.coordinator.lastHandledReloadToken = reloadToken
            uiView.reload()
        }

        if let update = progressUpdate, update.id != context.coordinator.lastHandledProgressUpdateId {
            context.coordinator.lastHandledProgressUpdateId = update.id
            let js = "if (typeof window.onNativePlaybackProgress === 'function') { window.onNativePlaybackProgress({ position: \(update.position), duration: \(update.duration), completed: \(update.completed) }); }"
            uiView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
    
    public class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebViewWrapper
        weak var webView: WKWebView?
        var currentURL: URL?
        var lastHandledReloadToken: Int = 0
        var lastHandledGoBackToken: Int = 0
        var lastHandledGoForwardToken: Int = 0
        var lastHandledProgressUpdateId: UUID?
        
        init(_ parent: WebViewWrapper) {
            self.parent = parent
        }
        
        @objc func handleRefresh(_ sender: UIRefreshControl) {
            webView?.reload()
            sender.endRefreshing()
        }
        
        // MARK: - WKNavigationDelegate
        
        public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = true
                self.parent.navigationError = nil
            }
        }
        
        public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.canGoBack = webView.canGoBack
                self.parent.canGoForward = webView.canGoForward
                self.parent.navigationError = nil
            }
        }
        
        public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                let nsError = error as NSError
                if nsError.code == NSURLErrorCancelled {
                    return
                }
                
                // Tailnet-aware diagnostic message
                if nsError.domain == NSURLErrorDomain {
                    switch nsError.code {
                    case NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorTimedOut:
                        self.parent.navigationError = "Cannot reach Vault Streaming server (\(self.parent.url.host ?? "Tailnet")). Ensure your Tailscale VPN is connected."
                    case NSURLErrorNotConnectedToInternet:
                        self.parent.navigationError = "No network connection detected."
                    default:
                        self.parent.navigationError = error.localizedDescription
                    }
                } else {
                    self.parent.navigationError = error.localizedDescription
                }
            }
        }
        
        public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                let nsError = error as NSError
                if nsError.code == NSURLErrorCancelled {
                    return
                }
                self.parent.navigationError = error.localizedDescription
            }
        }

        public func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            completionHandler(.performDefaultHandling, nil)
        }
        
        // MARK: - WKScriptMessageHandler
        
        public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "vaultStreamingBridge" else { return }
            print("[VaultStreamingBridge] Message: \(message.body)")
            
            if let dict = message.body as? [String: Any],
               let action = dict["action"] as? String,
               action == "playNative",
               let urlString = dict["url"] as? String,
               let playURL = URL(string: urlString) {
                
                let title = (dict["title"] as? String) ?? "Video Stream"
                let posterUrl = dict["posterUrl"] as? String
                let startPosition = (dict["startPosition"] as? Double) ?? 0.0
                let mediaType = dict["mediaType"] as? String
                let season = dict["season"] as? Int
                let episode = dict["episode"] as? Int
                
                let item = StreamPlaybackItem(
                    url: playURL,
                    title: title,
                    posterUrl: posterUrl,
                    startPosition: startPosition,
                    mediaType: mediaType,
                    season: season,
                    episode: episode
                )
                
                DispatchQueue.main.async {
                    self.parent.activeStream = item
                }
            }
        }
        
        // MARK: - WKUIDelegate (JavaScript Panels)
        
        public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootVC = windowScene.windows.first?.rootViewController else {
                completionHandler()
                return
            }
            
            let alert = UIAlertController(title: AppConfig.appName, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler()
            })
            rootVC.present(alert, animated: true)
        }
        
        public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootVC = windowScene.windows.first?.rootViewController else {
                completionHandler(false)
                return
            }
            
            let alert = UIAlertController(title: AppConfig.appName, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                completionHandler(false)
            })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(true)
            })
            rootVC.present(alert, animated: true)
        }
    }
}
