import SwiftUI

/// Interactive servings stepper that re-scales ingredient quantities live.
struct ServingsScalerBlockView: View {
    let baseServings: Int
    let ingredients: [ScaledIngredient]

    @State private var servings: Int

    init(baseServings: Int, ingredients: [ScaledIngredient]) {
        self.baseServings = max(1, baseServings)
        self.ingredients = ingredients
        _servings = State(initialValue: max(1, baseServings))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack {
                Label("Ingredients", systemImage: "list.bullet")
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)

                Spacer()

                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    stepperButton("minus") { if servings > 1 { servings -= 1 } }
                    Text("\(servings) \(servings == 1 ? "serving" : "servings")")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .frame(minWidth: 72)
                    stepperButton("plus") { servings += 1 }
                }
            }

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                ForEach(Array(ingredients.enumerated()), id: \.offset) { _, ingredient in
                    HStack(alignment: .firstTextBaseline, spacing: OpenSourcebookTheme.Spacing.sm) {
                        Circle()
                            .fill(OpenSourcebookTheme.Colors.primary)
                            .frame(width: 5, height: 5)
                            .padding(.top, 7)

                        Text(quantityText(for: ingredient))
                            .font(OpenSourcebookTheme.Fonts.bodySemibold)
                            .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                            .frame(minWidth: 64, alignment: .leading)

                        Text(ingredient.name)
                            .font(OpenSourcebookTheme.Fonts.body)
                            .foregroundStyle(OpenSourcebookTheme.Colors.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
        .animation(OpenSourcebookTheme.Motion.quick, value: servings)
    }

    private func stepperButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button {
            action()
            OpenSourcebookHaptics.lightImpact()
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .frame(width: 30, height: 30)
                .background(OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
    }

    private func quantityText(for ingredient: ScaledIngredient) -> String {
        guard let quantity = ingredient.quantity else { return "to taste" }
        let scaled = quantity * Double(servings) / Double(baseServings)
        let rounded = (scaled * 100).rounded() / 100
        let number = rounded.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(rounded))
            : String(format: "%g", rounded)
        return ingredient.unit.isEmpty ? number : "\(number) \(ingredient.unit)"
    }
}
