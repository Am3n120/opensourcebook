import SwiftUI

/// App shell: Home · Feed · + · Library · Profile with a custom bottom bar
/// and a raised + button (DECISIONS.md #16). + is not a tab; it opens capture.
///
/// The bar's height is reserved once, here, as a bottom safe-area inset, so
/// no screen adds its own "clear the tab bar" padding.
struct RootTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        ZStack(alignment: .bottom) {
            ZStack {
                tab(.home) { HomeView() }
                tab(.feed) { FeedView() }
                tab(.library) { LibraryView() }
                tab(.profile) { ProfileView() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            OpenSourcebookTabBar(
                selectedTab: appState.selectedTab,
                onSelect: selectTab,
                onCapture: { appState.openCapture() }
            )
        }
        .background(OpenSourcebookTheme.Colors.background.ignoresSafeArea())
        // OpenSourcebookTheme is light-only; without this, system-colored text turns white
        // on the app's light surfaces when the phone is in dark mode.
        .preferredColorScheme(.light)
        .fullScreenCover(isPresented: $appState.isPlayerPresented) {
            PresentedPlayerView().preferredColorScheme(.light)
        }
        .sheet(isPresented: $appState.isCapturePresented) {
            CaptureView(initialDestination: appState.captureDestination)
                .preferredColorScheme(.light)
        }
    }

    /// Every tab stays mounted so its navigation stack, scroll position and
    /// filters survive switching; only the selected one is visible.
    private func tab<Content: View>(_ tab: AppTab, @ViewBuilder content: () -> Content) -> some View {
        // The inset goes on the content inside the stack: an inset applied
        // outside the NavigationStack does not reach its scroll views.
        NavigationStack {
            content()
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    Color.clear.frame(height: OpenSourcebookTabBarLayout.contentInset)
                }
                // The tabs hide the navigation bar, so nothing covers the
                // status-bar strip; paint it so scrolled content doesn't show through.
                .safeAreaInset(edge: .top, spacing: 0) {
                    Color.clear
                        .frame(height: 0)
                        .background(OpenSourcebookTheme.Colors.background.ignoresSafeArea(edges: .top))
                }
        }
            .opacity(appState.selectedTab == tab ? 1 : 0)
            .allowsHitTesting(appState.selectedTab == tab)
            .accessibilityHidden(appState.selectedTab != tab)
    }

    private func selectTab(_ tab: AppTab) {
        guard tab != appState.selectedTab else { return }
        OpenSourcebookHaptics.lightImpact()
        withAnimation(OpenSourcebookTheme.Motion.quick) {
            appState.selectedTab = tab
        }
    }
}

/// Layout constants shared by the tab bar and the content inset; they must
/// always agree, so they live in one place.
private enum OpenSourcebookTabBarLayout {
    /// Total bar height, excluding the raised + button.
    static let barHeight: CGFloat = 64
    /// Diameter of the + button.
    static let buttonSize: CGFloat = 52
    /// How far above the bar's top edge the + button's center floats.
    static let buttonLift: CGFloat = 3
    /// Bottom space content reserves: the bar plus the part of the + button
    /// that rises above it, so the last row is never covered.
    static var contentInset: CGFloat { barHeight + buttonSize / 2 + buttonLift }
}

private struct OpenSourcebookTabBar: View {
    let selectedTab: AppTab
    let onSelect: (AppTab) -> Void
    let onCapture: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            TabBarItem(tab: .home, icon: "house", label: "Home",
                       selectedTab: selectedTab, onSelect: onSelect)
            TabBarItem(tab: .feed, icon: "infinity", label: "Feed",
                       selectedTab: selectedTab, onSelect: onSelect)

            // Center slot; the + button floats above it.
            Color.clear.frame(width: OpenSourcebookTabBarLayout.buttonSize)

            TabBarItem(tab: .library, icon: "square.grid.2x2", label: "Library",
                       selectedTab: selectedTab, onSelect: onSelect)
            TabBarItem(tab: .profile, icon: "person", label: "Profile",
                       selectedTab: selectedTab, onSelect: onSelect)
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
        .frame(height: OpenSourcebookTabBarLayout.barHeight)
        .frame(maxWidth: .infinity)
        .background(.bar, ignoresSafeAreaEdges: .bottom)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(OpenSourcebookTheme.Colors.border)
                .frame(height: 1)
                .opacity(0.6)
        }
        .overlay(alignment: .top) {
            CaptureButton(action: onCapture)
                .alignmentGuide(.top) { dimensions in
                    dimensions[VerticalAlignment.center] + OpenSourcebookTabBarLayout.buttonLift
                }
        }
    }
}

private struct TabBarItem: View {
    let tab: AppTab
    let icon: String
    let label: String
    let selectedTab: AppTab
    let onSelect: (AppTab) -> Void

    private var isSelected: Bool { tab == selectedTab }

    var body: some View {
        Button {
            onSelect(tab)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 21, weight: .regular))
                Text(label)
                    .font(.system(size: 10, weight: isSelected ? .semibold : .medium))
            }
            .foregroundStyle(isSelected ? OpenSourcebookTheme.Colors.primary : OpenSourcebookTheme.Colors.muted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tab-\(String(describing: tab))")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct CaptureButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(OpenSourcebookTheme.Colors.text)
                .frame(width: OpenSourcebookTabBarLayout.buttonSize, height: OpenSourcebookTabBarLayout.buttonSize)
                .overlay {
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(.white)
                }
                .openSourcebookElevatedShadow()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Capture")
        .accessibilityIdentifier("tab-capture")
    }
}

#Preview {
    RootTabView()
        .environmentObject(OutputStore())
        .environmentObject(AppState())
        .environmentObject(DoneTickStore())
}
