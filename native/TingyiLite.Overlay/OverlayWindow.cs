using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;

namespace TingyiLite.Overlay;

public sealed class OverlayWindow : Window
{
    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x00000020;
    private const int WsExToolWindow = 0x00000080;
    private const int WsExLayered = 0x00080000;

    private readonly OverlayOptions _options;
    private readonly Ellipse _statusDot = new() { Width = 8, Height = 8 };
    private readonly TextBlock _metaText = new();
    private readonly TextBlock _captionText = new();
    private readonly TextBlock _translationText = new();
    private readonly StackPanel _contextStack = new() { Orientation = Orientation.Vertical };

    public OverlayWindow(OverlayOptions options)
    {
        _options = options;
        ApplyWorkAreaConstraints(SystemParameters.WorkArea);
        SizeToContent = SizeToContent.Height;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ClipToBounds = true;
        ResizeMode = ResizeMode.NoResize;
        Topmost = true;
        ShowInTaskbar = false;
        Focusable = !options.ClickThrough;
        Content = BuildContent();
        Loaded += (_, _) => PositionWindow();
        SizeChanged += (_, _) => PositionWindow();
        KeyDown += (_, args) =>
        {
            if (args.Key == Key.Escape)
            {
                Close();
            }
        };
        MouseLeftButtonDown += (_, _) =>
        {
            if (!options.ClickThrough)
            {
                DragMove();
            }
        };
    }

    public void UpdateSnapshot(OverlaySnapshot snapshot)
    {
        Dispatcher.Invoke(() =>
        {
            _statusDot.Fill = snapshot.Connected && snapshot.Live ? BrushFrom("#2dd4bf") : BrushFrom("#94a3b8");
            _metaText.Text = snapshot.SourceLabel ?? snapshot.Title;
            _captionText.Text = snapshot.LatestCaption;
            _translationText.Text = snapshot.LatestTranslation ?? "";
            _contextStack.Children.Clear();
            foreach (var item in snapshot.Context.Skip(snapshot.LatestIsPreview ? 0 : 1))
            {
                var line = new StackPanel { Orientation = Orientation.Vertical };
                line.Children.Add(new TextBlock
                {
                    Text = item.Segment.Text,
                    Foreground = BrushFrom("#B8FFFFFF"),
                    FontSize = Math.Max(15, _options.FontSize * 0.42),
                    FontWeight = FontWeights.SemiBold,
                    TextAlignment = TextAlignment.Center,
                    TextWrapping = TextWrapping.Wrap,
                    LineHeight = Math.Max(18, _options.FontSize * 0.52),
                    Margin = new Thickness(0, 2, 0, 0)
                });
                if (!string.IsNullOrWhiteSpace(item.Translation))
                {
                    line.Children.Add(new TextBlock
                    {
                        Text = item.Translation,
                        Foreground = BrushFrom("#DB8DE1D2"),
                        FontSize = Math.Max(14, _options.FontSize * 0.36),
                        FontWeight = FontWeights.SemiBold,
                        TextAlignment = TextAlignment.Center,
                        TextWrapping = TextWrapping.Wrap,
                        LineHeight = Math.Max(17, _options.FontSize * 0.46)
                    });
                }
                _contextStack.Children.Add(line);
            }
            PositionWindow();
        });
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var handle = new WindowInteropHelper(this).Handle;
        var exStyle = GetWindowLong(handle, GwlExStyle) | WsExToolWindow | WsExLayered;
        if (_options.ClickThrough)
        {
            exStyle |= WsExTransparent;
        }
        SetWindowLong(handle, GwlExStyle, exStyle);
    }

    private UIElement BuildContent()
    {
        _metaText.Foreground = BrushFrom("#B8FFFFFF");
        _metaText.FontSize = 13;
        _metaText.FontWeight = FontWeights.Bold;
        _metaText.TextTrimming = TextTrimming.CharacterEllipsis;
        _captionText.Text = "等待字幕";
        _captionText.Foreground = Brushes.White;
        _captionText.FontSize = _options.FontSize;
        _captionText.FontWeight = FontWeights.ExtraBold;
        _captionText.TextAlignment = TextAlignment.Center;
        _captionText.TextWrapping = TextWrapping.Wrap;
        _captionText.LineHeight = _options.FontSize * 1.22;
        _translationText.Foreground = BrushFrom("#FF8DE1D2");
        _translationText.FontSize = Math.Max(18, _options.FontSize * 0.62);
        _translationText.FontWeight = FontWeights.Bold;
        _translationText.TextAlignment = TextAlignment.Center;
        _translationText.TextWrapping = TextWrapping.Wrap;
        _translationText.LineHeight = Math.Max(22, _options.FontSize * 0.76);

        var meta = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center
        };
        meta.Children.Add(_statusDot);
        meta.Children.Add(new Border { Width = 8 });
        meta.Children.Add(_metaText);

        var content = new StackPanel();
        content.Children.Add(meta);
        content.Children.Add(_captionText);
        content.Children.Add(_translationText);
        content.Children.Add(_contextStack);

        var alpha = (byte)Math.Round(_options.Opacity * 255);
        return new Border
        {
            Padding = new Thickness(20, 14, 20, 18),
            CornerRadius = new CornerRadius(8),
            BorderBrush = BrushFrom("#24FFFFFF"),
            BorderThickness = new Thickness(1),
            Background = new SolidColorBrush(Color.FromArgb(alpha, 8, 12, 18)),
            ClipToBounds = true,
            Effect = new System.Windows.Media.Effects.DropShadowEffect
            {
                Color = Colors.Black,
                BlurRadius = 32,
                ShadowDepth = 0,
                Opacity = 0.36
            },
            Child = content
        };
    }

    private void PositionWindow()
    {
        var workArea = SystemParameters.WorkArea;
        ApplyWorkAreaConstraints(workArea);

        var windowWidth = BoundedActualDimension(ActualWidth, Width, workArea.Width);
        var windowHeight = BoundedActualDimension(ActualHeight, MaxHeight, workArea.Height);
        var maximumLeft = Math.Max(workArea.Left, workArea.Right - windowWidth);
        var maximumTop = Math.Max(workArea.Top, workArea.Bottom - windowHeight);
        var centeredLeft = workArea.Left + ((workArea.Width - windowWidth) / 2);
        var bottomAlignedTop = workArea.Bottom - Math.Max(windowHeight, 120) - _options.Bottom;

        Left = Math.Clamp(centeredLeft, workArea.Left, maximumLeft);
        Top = Math.Clamp(bottomAlignedTop, workArea.Top, maximumTop);
    }

    private void ApplyWorkAreaConstraints(Rect workArea)
    {
        var availableWidth = Math.Max(1, workArea.Width);
        var availableHeight = Math.Max(1, workArea.Height);
        MaxWidth = availableWidth;
        MaxHeight = availableHeight;
        Width = Math.Min(_options.Width, availableWidth);
    }

    private static double BoundedActualDimension(double actual, double configured, double available)
    {
        var dimension = actual > 0 && double.IsFinite(actual) ? actual : configured;
        return Math.Clamp(dimension, 0, Math.Max(0, available));
    }

    private static SolidColorBrush BrushFrom(string color) => new((Color)ColorConverter.ConvertFromString(color));

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);
}
