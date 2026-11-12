package com.hdr.v2.recognition;

import com.hdr.v2.V2Exception;
import com.hdr.v2.platform.W2Limits;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.MemoryCacheImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Iterator;

@Component
public class ImageValidator {
    public record Image(byte[] bytes,String digest,String contentType) {}
    public Image validate(MultipartFile file) {
        if(file.isEmpty()) throw new V2Exception(400,"请选择非空图片","INVALID_IMAGE");
        if(file.getSize()>W2Limits.IMAGE_MAX_BYTES) throw new V2Exception(413,"图片最大为5MiB","IMAGE_TOO_LARGE");
        try {
            byte[] bytes;
            try(var input=file.getInputStream()) { bytes=input.readNBytes((int)W2Limits.IMAGE_MAX_BYTES+1); }
            if(bytes.length>W2Limits.IMAGE_MAX_BYTES) throw new V2Exception(413,"图片最大为5MiB","IMAGE_TOO_LARGE");
            try(ImageInputStream input=new MemoryCacheImageInputStream(new ByteArrayInputStream(bytes))) {
                Iterator<ImageReader> readers=ImageIO.getImageReaders(input);
                if(!readers.hasNext()) throw invalid();
                ImageReader reader=readers.next();
                try {
                    String format=reader.getFormatName().toLowerCase(java.util.Locale.ROOT);
                    if(!format.equals("png") && !format.equals("jpeg") && !format.equals("jpg")) throw invalid();
                    reader.setInput(input,false,true);
                    int width=reader.getWidth(0),height=reader.getHeight(0);
                    if(width<1 || height<1 || width>W2Limits.MAX_SIDE || height>W2Limits.MAX_SIDE || (long)width*height>W2Limits.MAX_PIXELS)
                        throw new V2Exception(400,"图片像素尺寸超限","IMAGE_DIMENSIONS");
                    if(reader.getNumImages(true)!=1) throw invalid();
                    boolean[] warned={false};
                    reader.addIIOReadWarningListener((source,warning)->warned[0]=true);
                    BufferedImage decoded=reader.read(0);
                    if(warned[0]) throw invalid();
                    boolean ink=false;
                    for(int y=0;y<height && !ink;y++) for(int x=0;x<width;x++) {
                        int pixel=decoded.getRGB(x,y),alpha=(pixel>>>24)&255;
                        int luminance=(((pixel>>16)&255)*299+((pixel>>8)&255)*587+(pixel&255)*114)/1000;
                        int onWhite=(luminance*alpha+255*(255-alpha))/255;
                        if(onWhite<245) { ink=true; break; }
                    }
                    if(!ink) throw new V2Exception(400,"画板为空，请先书写数字","BLANK_IMAGE");
                    return new Image(bytes,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),format.equals("png")?"image/png":"image/jpeg");
                } finally { reader.dispose(); }
            }
        } catch(IOException | IllegalArgumentException error) { throw invalid(); }
        catch(LinkageError error) {
            // 本机 JDK 缺 lcms 原生库（色彩管理），CMYK 或带 ICC 的 JPEG 解码会抛 UnsatisfiedLinkError。
            // 这类图像需要重新导出为 sRGB，不能当成"服务异常"。
            throw new V2Exception(400, "这张图片的色彩配置暂不支持，请用手机相册或画图另存为普通 JPEG（sRGB）后重试",
                    "IMAGE_COLOR_PROFILE_UNSUPPORTED");
        }
        catch(NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    private V2Exception invalid() { return new V2Exception(400,"图片格式不支持或内容损坏","INVALID_IMAGE"); }
}
