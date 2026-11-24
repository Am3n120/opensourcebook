import SwiftUI

/// Selectable filter chip for horizontal chip rows (Library filters, category rows).
struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    init(_ title: String, isSelected: Bool, action: @escaping () -> Void) {
        self.title = title
        self.isSelected = isSelected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(isSelected ? Color.white : OpenSourcebookTheme.Colors.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(isSelected ? OpenSourcebookTheme.Colors.text : OpenSourcebookTheme.Colors.fill)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("filter-chip")
        .animation(OpenSourcebookTheme.Motion.quick, value: isSelected)
    }
}

#Preview {
    HStack {
        FilterChip("All", isSelected: true) {}
        FilterChip("Videos", isSelected: false) {}
        FilterChip("Checks", isSelected: false) {}
    }
    .padding()
}
