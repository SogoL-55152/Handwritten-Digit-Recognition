package com.hdr.v2.dataset;

import com.hdr.v2.V2Exception;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.zip.GZIPInputStream;

/**
 * IDX 读取（MNIST / EMNIST）：把「images-idx3 + labels-idx1」按需转成 28×28 PNG。
 *
 * - 支持 .gz 压缩与未压缩两种文件
 * - EMNIST 存放时按行列转置，这里转置回来（与训练脚本 read_emnist_digits 约定一致）
 * - byclass 数据集标签 1–10 对应数字 0–9，其余标签（字母）跳过
 */
final class IdxReader {
    private static final Logger LOG = LoggerFactory.getLogger(IdxReader.class);
    private static final int MAGIC_IMAGES = 2051;
    private static final int MAGIC_LABELS = 2049;

    record Pair(Path images, Path labels, String name, boolean emnist, boolean byclass) {}

    private IdxReader() {}

    static boolean isIdx(Path dir) {
        return !pairs(dir).isEmpty();
    }

    /** 找同前缀的 images/labels 配对：train、t10k 等。 */
    static List<Pair> pairs(Path dir) {
        if (!Files.isDirectory(dir)) return List.of();
        List<Path> images;
        try (Stream<Path> stream = Files.list(dir)) {
            images = stream.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().matches(".*-images-idx3-ubyte(\\.gz)?"))
                    .sorted()
                    .toList();
        } catch (IOException error) {
            return List.of();
        }
        List<Pair> result = new ArrayList<>();
        for (Path image : images) {
            String name = image.getFileName().toString();
            String prefix = name.substring(0, name.indexOf("-images-idx3-ubyte"));
            Path labels = null;
            try (Stream<Path> stream = Files.list(dir)) {
                labels = stream.filter(Files::isRegularFile)
                        .filter(path -> path.getFileName().toString().startsWith(prefix + "-labels-idx1-ubyte"))
                        .findFirst().orElse(null);
            } catch (IOException ignored) {
                // 保持 labels 为 null，下面统一跳过
            }
            if (labels == null) continue;
            String lower = (dir.toString() + "/" + name).toLowerCase();
            boolean emnist = lower.contains("emnist");
            boolean byclass = lower.contains("byclass");
            result.add(new Pair(image, labels, prefix, emnist, byclass));
        }
        return result;
    }

    static int labelOf(int raw, Pair pair) {
        if (pair.byclass()) {
            // byclass: 1='0' … 10='9'，11 以上是字母
            return raw >= 1 && raw <= 10 ? raw - 1 : -1;
        }
        return raw >= 0 && raw <= 9 ? raw : -1;
    }

    /** 只读标签，统计 0–9 数量（试运行用，不解析图片）。 */
    static Map<String, Integer> countLabels(List<Pair> pairs) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Pair pair : pairs) {
            try (DataInputStream input = open(pair.labels())) {
                int magic = input.readInt();
                if (magic != MAGIC_LABELS) throw new IOException("labels magic " + magic);
                int count = input.readInt();
                byte[] buffer = new byte[count];
                input.readFully(buffer);
                for (byte value : buffer) {
                    int label = labelOf(value & 0xFF, pair);
                    if (label >= 0) counts.merge(String.valueOf(label), 1, Integer::sum);
                }
            } catch (IOException error) {
                LOG.warn("IDX 标签读取失败: {}", error.getMessage());
            }
        }
        return counts;
    }

    interface SampleSink {
        void accept(int label, byte[] png) throws IOException;
    }

    /** 逐张解析并转 PNG；遇到坏样本跳过并计数。 */
    static int streamLabelsAndImages(List<Pair> pairs, SampleSink sink) {
        int written = 0;
        for (Pair pair : pairs) {
            try (DataInputStream labels = open(pair.labels()); DataInputStream images = open(pair.images())) {
                if (labels.readInt() != MAGIC_LABELS) throw new IOException("labels magic");
                int count = labels.readInt();
                byte[] labelBytes = new byte[count];
                labels.readFully(labelBytes);

                if (images.readInt() != MAGIC_IMAGES) throw new IOException("images magic");
                int imageCount = images.readInt();
                int rows = images.readInt();
                int cols = images.readInt();
                int limit = Math.min(count, imageCount);
                for (int index = 0; index < limit; index += 1) {
                    byte[] pixels = new byte[rows * cols];
                    images.readFully(pixels);
                    int label = labelOf(labelBytes[index] & 0xFF, pair);
                    if (label < 0) continue;
                    try {
                        sink.accept(label, toPng(pixels, rows, cols, pair.emnist()));
                        written += 1;
                    } catch (IOException error) {
                        LOG.warn("IDX 第 {} 张转换失败: {}", index, error.getMessage());
                    }
                }
            } catch (IOException error) {
                throw new V2Exception(400, "IDX 文件解析失败：" + error.getMessage(), "IDX_INVALID");
            }
        }
        return written;
    }

    private static byte[] toPng(byte[] pixels, int rows, int cols, boolean emnist) throws IOException {
        BufferedImage image = new BufferedImage(cols, rows, BufferedImage.TYPE_BYTE_GRAY);
        int width = emnist ? rows : cols;
        int height = emnist ? cols : rows;
        BufferedImage output = emnist ? new BufferedImage(width, height, BufferedImage.TYPE_BYTE_GRAY) : image;
        for (int y = 0; y < rows; y += 1) {
            for (int x = 0; x < cols; x += 1) {
                int value = pixels[y * cols + x] & 0xFF;
                int gray = (value << 16) | (value << 8) | value;
                if (emnist) output.setRGB(y, x, gray);
                else image.setRGB(x, y, gray);
            }
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        ImageIO.write(output, "png", buffer);
        return buffer.toByteArray();
    }

    private static DataInputStream open(Path path) throws IOException {
        InputStream raw = Files.newInputStream(path);
        InputStream stream = new BufferedInputStream(raw);
        if (path.getFileName().toString().endsWith(".gz")) stream = new GZIPInputStream(stream);
        return new DataInputStream(stream);
    }
}
