import { withSessionProtected } from '@app/hooks/useSignin/hocs/withSessionProtected';
import { Button, Card } from '@ballerine/ui';

export const Approved = withSessionProtected(() => {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-[646px] p-12">
        <div className="mb-9 flex flex-col items-center gap-9">
          <img src="/public/app-logo.svg" className="h-[40px] w-[95px]" />
          <img src="/public/success-circle.svg" className="h-[156px] w-[156px]" />
        </div>
        <div className="mb-10">
          <h1 className="mb-6 text-center text-3xl font-bold leading-8">
            Application completed <br />
            successfully!
          </h1>
          <p className="text-muted-foreground text-center text-sm leading-5 opacity-50">
            Go back to PayLynk’s portal to use the system
          </p>
        </div>
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => alert('Not implemented.')}>
            Go back to PayLynk’s Portal
          </Button>
        </div>
      </Card>
    </div>
  );
});
