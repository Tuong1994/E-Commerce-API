import * as bcryptjs from 'bcryptjs';
import * as crypto from 'crypto';
import { ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { AuthChangePasswordDto, AuthDto, AuthForgotPasswordDto, AuthResetPasswordDto } from './auth.dto';
import { TokenPayload } from './auth.type';
import { getEmailResetPasswordTemplate } from 'src/common/template/resetPassword';
import { AuthHelper } from './auth.helper';
import { ELang, ERole } from 'src/common/enum/base';
import { QueryDto } from 'src/common/dto/query.dto';
import { EmailHelper } from '../email/email.helper';
import utils from 'src/utils';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private authHelper: AuthHelper,
    private emailHelper: EmailHelper,
  ) {}

  async signUp(auth: AuthDto) {
    const { email, password, phone } = auth;

    const exist = await this.prisma.user.findUnique({ where: { email } });
    if (exist) throw new ForbiddenException('Email is already exist');

    const hashPass = utils.bcryptHash(password);
    const newAccount = await this.prisma.user.create({
      data: { email, password: hashPass, phone, isDelete: false, role: ERole.CUSTOMER },
    });
    if (newAccount) {
      await this.prisma.userPermission.create({
        data: {
          create: false,
          update: false,
          remove: false,
          isDelete: false,
          userId: newAccount.id,
        },
      });
      return newAccount;
    }
    throw new HttpException('Sign up failed', HttpStatus.BAD_REQUEST);
  }

  async signIn(query: QueryDto, auth: AuthDto) {
    const { admin } = query;
    const { email, password } = auth;

    const login = await this.prisma.user.findUnique({
      where: { email },
      include: {
        image: { select: { id: true, path: true, size: true, publicId: true } },
        permission: { select: { id: true, create: true, update: true, remove: true } },
      },
    });
    if (!login) throw new HttpException('Email is not correct', HttpStatus.NOT_FOUND);

    const isAuth = bcryptjs.compareSync(password, login.password);
    if (!isAuth) throw new ForbiddenException('Password is not correct');

    if (admin && login.role === ERole.CUSTOMER)
      throw new UnauthorizedException("You're not authorize to proccess");

    const info = { ...login };
    delete info.password;
    delete info.createdAt;
    delete info.updatedAt;
    const payload: TokenPayload = {
      id: login.id,
      email: login.email,
      role: login.role,
    };
    const accessToken = await this.authHelper.getAccessToken(payload);
    const refreshToken = await this.authHelper.getRefreshToken(payload);
    await this.prisma.auth.upsert({
      where: { userId: login.id },
      create: { token: refreshToken, userId: login.id },
      update: { token: refreshToken },
    });
    return {
      accessToken: accessToken.token,
      expired: accessToken.expirationTimeInSeconds,
      info,
      isAuth: true,
    };
  }

  async refresh(query: QueryDto) {
    const { userId } = query;
    const auth = await this.prisma.auth.findUnique({ where: { userId } });
    if (!auth) throw new ForbiddenException('Token not found');
    try {
      const decode = this.jwt.verify(auth.token, {
        secret: this.config.get('REFRESH_TOKEN_SECRET'),
      });
      if (decode) {
        const payload: TokenPayload = {
          id: decode.id,
          email: decode.email,
          role: decode.role,
        };
        const { token, expirationTimeInSeconds } = await this.authHelper.getAccessToken(payload);
        return { accessToken: token, expired: expirationTimeInSeconds };
      }
    } catch (error) {
      if (error instanceof TokenExpiredError) throw new ForbiddenException('Token is expired');
    }
  }

  async changePassword(query: QueryDto, password: AuthChangePasswordDto) {
    const { userId } = query;
    const { oldPassword, newPassword } = password;

    const customer = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!customer) throw new HttpException('Customer not found', HttpStatus.NOT_FOUND);
    const isAuth = bcryptjs.compareSync(oldPassword, customer.password);
    if (!isAuth) throw new ForbiddenException('Old password is not correct');

    const hash = utils.bcryptHash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hash } });
    throw new HttpException('Password has successfully changed', HttpStatus.OK);
  }

  async forgotPassword(query: QueryDto, data: AuthForgotPasswordDto) {
    const { langCode, admin } = query;
    const { email } = data;

    const auth = await this.prisma.user.findUnique({ where: { email } });
    if (!auth) throw new ForbiddenException('Email is not correct');
    const { token, tokenHash, expires } = this.authHelper.getPasswordResetToken();
    await this.prisma.user.update({
      where: { email },
      data: { resetToken: tokenHash, resetTokenExpires: expires },
    });

    const baseUrl = admin ? 'http://localhost:5173' : 'http://localhost:3000';
    const resetUrl = `${baseUrl}/auth/resetPassword/${token}?langCode=${langCode}`;
    const subject = langCode === ELang.EN ? 'Reset password' : 'Đặt lại mật khẩu';
    try {
      await this.emailHelper.sendGmail({
        to: email,
        subject,
        html: getEmailResetPasswordTemplate(langCode, auth.fullName, resetUrl),
      });
      throw new HttpException('Email has been sent', HttpStatus.OK);
    } catch (error) {
      if (error && error.status > 200) {
        await this.prisma.user.update({
          where: { email },
          data: { resetToken: null, resetTokenExpires: null },
        });
      }
    }
  }

  async resetPassword(data: AuthResetPasswordDto) {
    const { resetPassword, token } = data;
    const resetToken = crypto.createHash('sha256').update(token).digest('hex');
    const auth = await this.prisma.user.findFirst({
      where: { resetToken, resetTokenExpires: { gt: Date.now() } },
    });
    if (!auth) throw new HttpException('Reset token has been expires or invalid', HttpStatus.BAD_REQUEST);
    await this.prisma.user.update({
      where: { id: auth.id },
      data: { password: utils.bcryptHash(resetPassword), resetToken: null, resetTokenExpires: null },
    });
    throw new HttpException('Password has been reset', HttpStatus.OK);
  }

  async logout(query: QueryDto) {
    const { userId } = query;
    const auth = await this.prisma.auth.findUnique({ where: { userId } });
    if (!auth) throw new HttpException('Logout success', HttpStatus.OK);
    await this.prisma.auth.delete({ where: { id: auth.id } });
    throw new HttpException('Logout success', HttpStatus.OK);
  }
}
