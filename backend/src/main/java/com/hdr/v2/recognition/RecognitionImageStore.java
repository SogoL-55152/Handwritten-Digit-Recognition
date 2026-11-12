package com.hdr.v2.recognition;

import com.hdr.v2.V2Exception;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Optional;

/**
 * 识别原图存储：按工作空间 + 年月 + 摘要去重落盘，路径不允许逃逸出根目录。
 * 只服务于"查看自己的识别记录"，不对外提供列表。
 */
@Component
public class RecognitionImageStore {
    private static final Logger LOG = LoggerFactory.getLogger(RecognitionImageStore.class);
    private static final DateTimeFormatter MONTH = DateTimeFormatter.ofPattern("yyyyMM");

    private final Path root;

    public RecognitionImageStore(@Value("${hdr.recognition.dir:recognition-images}") String directory) {
        this.root = Paths.get(directory).toAbsolutePath().normalize();
    }

    /** 保存原图，返回相对路径；同一摘要重复保存是幂等的。 */
    public String save(long workspaceId, ImageValidator.Image image) {
        String extension = "image/png".equals(image.contentType()) ? "png" : "jpg";
        Path target = root.resolve(Long.toString(workspaceId))
                .resolve(LocalDate.now().format(MONTH))
                .resolve(image.digest() + "." + extension).normalize();
        if (!target.startsWith(root)) throw new V2Exception(400, "图片路径无效", "VALIDATION");
        try {
            Files.createDirectories(target.getParent());
            if (!Files.exists(target)) Files.write(target, image.bytes());
        } catch (IOException error) {
            LOG.warn("Recognition image write failed ({})", error.getClass().getSimpleName());
            throw new V2Exception(503, "图片保存失败，请稍后重试", "STORAGE_UNAVAILABLE");
        }
        return root.relativize(target).toString().replace('\\', '/');
    }

    /** 读取已保存的原图；路径必须仍在根目录内。 */
    public byte[] read(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) throw new V2Exception(404, "该记录没有保存图片", "IMAGE_NOT_FOUND");
        Path target = root.resolve(relativePath).normalize();
        if (!target.startsWith(root) || !Files.isRegularFile(target))
            throw new V2Exception(404, "该记录没有保存图片", "IMAGE_NOT_FOUND");
        try {
            return Files.readAllBytes(target);
        } catch (IOException error) {
            throw new V2Exception(503, "图片读取失败，请稍后重试", "STORAGE_UNAVAILABLE");
        }
    }

    public Optional<String> contentTypeOf(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) return Optional.empty();
        return Optional.of(relativePath.endsWith(".png") ? "image/png" : "image/jpeg");
    }
}
